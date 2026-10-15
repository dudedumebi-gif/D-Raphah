import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  HandoffRequirement,
  LeadEngineHandoffPackage,
} from "@raphah/handoff-contract";
import type { NeonClient } from "../api/_lib/db.js";
import {
  buildUseCaseWorkflowDraft,
  ensureUseCaseWorkflows,
  generateUseCaseWorkflowsForAcceptedPackage,
  humanizeRequirementTitle,
  isGeneratableRequirement,
  listProjectUseCaseWorkflows,
  type UseCaseWorkflowProjectRef,
} from "../api/_lib/use-case-workflows.js";
import { NODE_CATALOG } from "../api/_lib/workflows.js";
import { packageBase, signTestPackage } from "./helpers.js";

/**
 * Use-case workflow skeletons (user request, 2026-10-14): a landed
 * handoff package's approved use cases should become draft workflows
 * automatically — the Charter for Donddental showed requirements with
 * nothing to begin or test because no generic lead_handoff workflow
 * was published in the production scope. The generator reads only
 * DF's stored package, is idempotent per (project, requirement),
 * never publishes or executes, and the intake wrapper is fail-open.
 */

/* ── Fake engine ─────────────────────────────────────────────────────── */

interface StoredNode {
  node_key: unknown;
  type: unknown;
  kind: string;
  label: unknown;
  position_x: unknown;
  position_y: unknown;
  config: Record<string, unknown>;
  enabled: unknown;
}

interface StoredWorkflow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  environment: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  created_by: string | null;
  nodes: StoredNode[];
  edges: Array<Record<string, unknown>>;
  /** Optional fixed timestamps (tests of the never-updated marker). */
  created_at?: string;
  updated_at?: string;
}

function donddentalPackage(): LeadEngineHandoffPackage {
  const signed = signTestPackage(
    packageBase({
      organization: { name: "Donddental", domain: "donddental.ca" },
      requirementBaseline: {
        version: 1,
        requirements: [
          {
            id: randomUUID(),
            opportunityId: randomUUID(),
            code: "UC-ONLINE-APPOINTMENT-BOOKING",
            statement:
              "The business will enable patients to book appointments online seamlessly.",
            priority: "must",
            status: "validated",
            humanValidatorId: "reviewer-1",
            acceptanceCriteria: [
              "Patients can book appointments 24/7 through the website",
              "Confirmation emails are sent to patients immediately after booking",
            ],
            blockingQuestions: [],
          },
          {
            id: randomUUID(),
            opportunityId: randomUUID(),
            code: "UC-AUTOMATED-REMINDERS-NO-SHOW-REDUCTION",
            statement:
              "The business will automatically send appointment reminders to reduce no-show rates.",
            priority: "must",
            status: "validated",
            humanValidatorId: "reviewer-1",
            acceptanceCriteria: [
              "Patients receive reminders 24 hours before their appointments",
              "No-show rates decrease by at least 15% within three months",
            ],
            blockingQuestions: [],
          },
          {
            id: randomUUID(),
            opportunityId: randomUUID(),
            code: "UC-AUTOMATED-REVIEW-REFERRAL-REQUESTS",
            statement:
              "The business will automate the process of requesting reviews and referrals from satisfied patients.",
            priority: "must",
            status: "validated",
            humanValidatorId: "reviewer-1",
            acceptanceCriteria: [
              "Automated emails are sent to patients after their appointments asking for reviews",
            ],
            blockingQuestions: [],
          },
        ],
        features: [],
      },
      successMeasures: [
        {
          metric: "Increase in online bookings",
          target:
            "Achieve a 30% increase in online appointment bookings within the next quarter",
        },
        {
          metric: "Reduction in no-show appointments",
          target:
            "Achieve a 15% reduction in no-show rates within the next quarter",
        },
        {
          metric: "Increase in patient reviews and referrals",
          target:
            "Achieve a 25% increase in online reviews and referrals within the next quarter",
        },
      ],
    }),
  );
  return signed.pkg;
}

function makeEngine() {
  const workflows = new Map<string, StoredWorkflow>();
  /** projectId -> stored package (the handoff_inbox join). */
  const packages = new Map<string, LeadEngineHandoffPackage>();
  /** packageId -> projectId (delivery_projects lookup). */
  const projectsByPackage = new Map<string, string>();
  /** projectId -> project row facts. */
  const projectRows = new Map<string, UseCaseWorkflowProjectRef>();
  /** workflow_runs rows (workflow_id only — the count is what matters). */
  const runs: Array<{ workflow_id: string }> = [];

  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0];
    if (head.includes("join public.handoff_inbox")) {
      const pkg = packages.get(String(values[0]));
      return pkg ? [{ package: pkg }] : [];
    }
    if (
      head.includes("from public.delivery_projects") &&
      head.includes("organization_name")
    ) {
      const row = projectRows.get(String(values[0]));
      return row
        ? [
            {
              id: row.id,
              environment: row.environment,
              package_id: row.package_id,
              organization_name: row.organization_name,
            },
          ]
        : [];
    }
    if (
      head.includes("from public.delivery_projects") &&
      head.includes("select id")
    ) {
      const pid = projectsByPackage.get(String(values[0]));
      return pid ? [{ id: pid }] : [];
    }
    if (
      head.includes("from public.workflows") &&
      head.includes("skeleton_runs")
    ) {
      // findAndAssessSkeleton: values are environment, projectId,
      // requirementId — one row with computed completeness, run
      // count, and timestamps.
      const match = [...workflows.values()].find(
        (w) =>
          w.environment === String(values[0]) &&
          w.trigger_config.projectId === String(values[1]) &&
          w.trigger_config.requirementId === String(values[2]),
      );
      if (!match) return [];
      const stamp = new Date().toISOString();
      return [
        {
          id: match.id,
          name: match.name,
          status: match.status,
          created_at: match.created_at ?? stamp,
          updated_at: match.updated_at ?? match.created_at ?? stamp,
          skeleton_node_kinds: new Set(
            match.nodes
              .map((n) => String(n.node_key))
              .filter((k) =>
                ["trigger-1", "action-1", "action-2", "action-3"].includes(k),
              ),
          ).size,
          skeleton_edges: match.edges.length,
          skeleton_runs: runs.filter((r) => r.workflow_id === match.id)
            .length,
        },
      ];
    }
    if (
      head.includes("from public.workflows") &&
      head.includes("skeleton_node_kinds")
    ) {
      // listProjectUseCaseWorkflows: values are environment, projectId.
      return [...workflows.values()]
        .filter(
          (w) =>
            w.environment === String(values[0]) &&
            w.trigger_config.projectId === String(values[1]),
        )
        .map((w) => ({
          id: w.id,
          name: w.name,
          status: w.status,
          trigger_config: w.trigger_config,
          skeleton_node_kinds: new Set(
            w.nodes
              .map((n) => String(n.node_key))
              .filter((k) =>
                ["trigger-1", "action-1", "action-2", "action-3"].includes(k),
              ),
          ).size,
          skeleton_edges: w.edges.length,
        }));
    }
    if (
      head.includes("from public.workflows") &&
      head.includes("select id, name, status")
    ) {
      // findUseCaseWorkflow: values are environment, projectId,
      // requirementId (the unique key — codes can collide).
      const match = [...workflows.values()].find(
        (w) =>
          w.environment === String(values[0]) &&
          w.trigger_config.projectId === String(values[1]) &&
          w.trigger_config.requirementId === String(values[2]),
      );
      return match
        ? [{ id: match.id, name: match.name, status: match.status }]
        : [];
    }
    if (
      head.includes("from public.workflow_runs") &&
      head.includes("count(*)")
    ) {
      return [
        { runs: runs.filter((r) => r.workflow_id === String(values[0])).length },
      ];
    }
    if (head.includes("delete from public.workflows")) {
      // deleteUntouchedSkeleton: drafts/archived only, and the
      // untouched marker (updated_at = created_at, zero runs, older
      // than the in-flight grace) is revalidated by the statement.
      const wf = workflows.get(String(values[0]));
      if (!wf) return [];
      const statusOk = wf.status === "draft" || wf.status === "archived";
      const untouched =
        (wf.updated_at ?? wf.created_at) === (wf.created_at ?? wf.updated_at) ||
        (wf.created_at === undefined && wf.updated_at === undefined);
      // values[1] is the ignoreAge flag (the caller's own failed
      // create waives the in-flight grace for its own row only).
      const aged =
        values[1] === true
          ? true
          : wf.created_at
            ? Date.now() - Date.parse(wf.created_at) >= 60_000
            : false;
      const runCount = runs.filter((r) => r.workflow_id === wf.id).length;
      if (statusOk && untouched && aged && runCount === 0) {
        workflows.delete(wf.id);
        return [{ id: wf.id }];
      }
      return [];
    }
    if (head.includes("insert into public.workflows")) {
      // Mirrors uq_workflows_use_case_skeleton (migration
      // 202610140002): one skeleton per (projectId, requirementId).
      const triggerConfig = JSON.parse(String(values[3])) as Record<
        string,
        unknown
      >;
      if (triggerConfig.projectId && triggerConfig.requirementId) {
        const clash = [...workflows.values()].some(
          (w) =>
            w.environment === String(values[5]) &&
            w.trigger_config.projectId === triggerConfig.projectId &&
            w.trigger_config.requirementId ===
              triggerConfig.requirementId,
        );
        if (clash) {
          throw new Error(
            'duplicate key value violates unique constraint "uq_workflows_use_case_skeleton"',
          );
        }
      }
      const id = randomUUID();
      workflows.set(id, {
        id,
        name: String(values[0]),
        description: values[1] ? String(values[1]) : null,
        status: "draft",
        trigger_type: String(values[2]),
        trigger_config: JSON.parse(String(values[3])) as Record<
          string,
          unknown
        >,
        created_by: values[4] ? String(values[4]) : null,
        environment: String(values[5]),
        nodes: [],
        edges: [],
      });
      return [{ id }];
    }
    if (head.includes("delete from public.workflow_edges")) {
      const wf = workflows.get(String(values[0]));
      if (wf) wf.edges = [];
      return [];
    }
    if (head.includes("delete from public.workflow_nodes")) {
      const wf = workflows.get(String(values[0]));
      if (wf) wf.nodes = [];
      return [];
    }
    if (head.includes("insert into public.workflow_nodes")) {
      const wf = workflows.get(String(values[0]));
      wf?.nodes.push({
        node_key: values[1],
        type: values[2],
        kind: String(values[3]),
        label: values[4],
        position_x: values[5],
        position_y: values[6],
        config: JSON.parse(String(values[7])),
        enabled: values[8],
      });
      return [];
    }
    if (head.includes("insert into public.workflow_edges")) {
      const wf = workflows.get(String(values[0]));
      wf?.edges.push({
        edge_key: values[1],
        from_node_key: values[2],
        to_node_key: values[3],
        from_port: values[4],
        label: values[5],
      });
      return [];
    }
    if (head.includes("from public.workflows where id =")) {
      const w = workflows.get(String(values[0]));
      if (!w) return [];
      // One insert stamps both columns with the same now():
      // fabricate a single instant so untouched rows read equal.
      const stamp = new Date().toISOString();
      return [
        {
          id: w.id,
          name: w.name,
          description: w.description,
          status: w.status,
          environment: w.environment,
          trigger_type: w.trigger_type,
          trigger_config: w.trigger_config,
          created_by: w.created_by,
          created_at: w.created_at ?? stamp,
          updated_at: w.updated_at ?? w.created_at ?? stamp,
          published_at: null,
        },
      ];
    }
    if (head.includes("from public.workflow_nodes")) {
      return workflows.get(String(values[0]))?.nodes ?? [];
    }
    if (head.includes("from public.workflow_edges")) {
      return workflows.get(String(values[0]))?.edges ?? [];
    }
    throw new Error(`Unexpected query: ${head.slice(0, 100)}`);
  }) as unknown as NeonClient;

  return { db, workflows, packages, projectsByPackage, projectRows, runs };
}

function seedProject(
  engine: ReturnType<typeof makeEngine>,
  pkg: LeadEngineHandoffPackage,
): UseCaseWorkflowProjectRef {
  const project: UseCaseWorkflowProjectRef = {
    id: randomUUID(),
    environment: "production",
    package_id: pkg.packageId,
    organization_name: pkg.organization.name,
  };
  engine.packages.set(project.id, pkg);
  engine.projectsByPackage.set(pkg.packageId, project.id);
  engine.projectRows.set(project.id, project);
  return project;
}

/* ── humanize ────────────────────────────────────────────────────────── */

describe("humanizeRequirementTitle", () => {
  it("title-cases LE's UC- slug codes", () => {
    expect(
      humanizeRequirementTitle({
        code: "UC-ONLINE-APPOINTMENT-BOOKING",
        statement: "ignored",
      }),
    ).toBe("Online Appointment Booking");
    expect(
      humanizeRequirementTitle({
        code: "UC-AUTOMATED-REMINDERS-NO-SHOW-REDUCTION",
        statement: "ignored",
      }),
    ).toBe("Automated Reminders No Show Reduction");
  });

  it("falls back to the statement for wordless codes", () => {
    expect(
      humanizeRequirementTitle({
        code: "REQ-001",
        statement: "The system must automate invoice reconciliation.",
      }),
    ).toBe("The system must automate invoice reconciliation.");
  });
});

/* ── generator ───────────────────────────────────────────────────────── */

describe("ensureUseCaseWorkflows", () => {
  it("creates one draft skeleton per requirement in a 3-requirement package", async () => {
    const engine = makeEngine();
    const pkg = donddentalPackage();
    const project = seedProject(engine, pkg);

    const result = await ensureUseCaseWorkflows(engine.db, project);

    expect(result.existing).toEqual([]);
    expect(result.created).toHaveLength(3);
    expect(result.created.map((s) => s.name)).toEqual([
      "Donddental — Online Appointment Booking",
      "Donddental — Automated Reminders No Show Reduction",
      "Donddental — Automated Review Referral Requests",
    ]);
    expect(result.created.every((s) => s.status === "draft")).toBe(true);
    expect([...engine.workflows.values()].map((w) => w.created_by)).toEqual([
      "intake-skeleton",
      "intake-skeleton",
      "intake-skeleton",
    ]);
    for (const wf of engine.workflows.values()) {
      expect(wf.status).toBe("draft");
      expect(wf.environment).toBe("production");
      expect(wf.trigger_type).toBe("manual");
      expect(wf.trigger_config.projectId).toBe(project.id);
      expect(wf.trigger_config.packageId).toBe(pkg.packageId);
      expect(typeof wf.trigger_config.requirementCode).toBe("string");
    }
  });

  it("seeds a catalog-shaped graph whose prompts carry the requirement", async () => {
    const engine = makeEngine();
    const pkg = donddentalPackage();
    const project = seedProject(engine, pkg);
    await ensureUseCaseWorkflows(engine.db, project);

    const catalogKinds = new Set<string>(NODE_CATALOG.map((s) => s.kind));
    const first = [...engine.workflows.values()].find(
      (w) =>
        w.trigger_config.requirementCode === "UC-ONLINE-APPOINTMENT-BOOKING",
    );
    expect(first).toBeDefined();
    expect(first!.nodes.map((n) => n.kind)).toEqual([
      "manual",
      "ai_assist",
      "send_email",
      "log_database",
    ]);
    for (const wf of engine.workflows.values()) {
      for (const node of wf.nodes) {
        expect(catalogKinds.has(node.kind)).toBe(true);
      }
      // Linear chain: trigger -> ai -> email -> log.
      expect(wf.edges.map((e) => [e.from_node_key, e.to_node_key])).toEqual([
        ["trigger-1", "action-1"],
        ["action-1", "action-2"],
        ["action-2", "action-3"],
      ]);
      // Positions march down the canvas.
      const ys = wf.nodes.map((n) => n.position_y as number);
      expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    }

    const ai = first!.nodes.find((n) => n.kind === "ai_assist");
    const prompt = String(ai?.config.userPrompt ?? "");
    expect(prompt).toContain("UC-ONLINE-APPOINTMENT-BOOKING");
    expect(prompt).toContain(
      "Patients can book appointments 24/7 through the website",
    );
    expect(prompt).toContain(
      "Confirmation emails are sent to patients immediately after booking",
    );
    // The package's measures ride along as unattributed context.
    expect(prompt).toContain("Increase in online bookings");
    expect(prompt).toContain("30% increase");

    const email = first!.nodes.find((n) => n.kind === "send_email");
    expect(email?.config.subject).toBe(
      "Donddental — Online Appointment Booking",
    );
    expect(String(email?.config.body ?? "")).toContain(
      "Patients can book appointments 24/7 through the website",
    );
    // Draft posture: no recipient is pre-filled; nothing can send itself.
    expect(email?.config.to).toBe("");

    const log = first!.nodes.find((n) => n.kind === "log_database");
    expect(String(log?.config.message ?? "")).toContain(
      "UC-ONLINE-APPOINTMENT-BOOKING",
    );
    expect(String(log?.config.message ?? "")).toContain(project.id);
  });

  it("is idempotent: a second call creates nothing and reports existing", async () => {
    const engine = makeEngine();
    const pkg = donddentalPackage();
    const project = seedProject(engine, pkg);

    const first = await ensureUseCaseWorkflows(engine.db, project);
    const second = await ensureUseCaseWorkflows(engine.db, project);

    expect(first.created).toHaveLength(3);
    expect(second.created).toEqual([]);
    expect(second.existing).toHaveLength(3);
    expect(second.existing.map((s) => s.id)).toEqual(
      first.created.map((s) => s.id),
    );
    expect(engine.workflows.size).toBe(3);

    const listed = await listProjectUseCaseWorkflows(
      engine.db,
      project.id,
      "production",
    );
    expect(listed).toHaveLength(3);
    expect(listed[0].requirementCode).toBe("UC-ONLINE-APPOINTMENT-BOOKING");
    // Generator-produced skeletons list as complete (round 8).
    expect(listed.every((s) => s.complete)).toBe(true);
  });

  it("adopts the winner when a concurrent create wins the race (Codex on PR #60)", async () => {
    const engine = makeEngine();
    const pkg = donddentalPackage();
    const project = seedProject(engine, pkg);
    const firstRequirement = pkg.requirementBaseline.requirements[0];

    // Simulate the race: as this call tries to insert the first
    // skeleton, a concurrent generator completes its own insert of a
    // complete skeleton for the same requirement — the unique index
    // then rejects ours, and we must adopt the winner, not fail.
    let raced = false;
    const racingDb = (async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      if (!raced && strings[0].includes("insert into public.workflows")) {
        raced = true;
        const rivalDraft = buildUseCaseWorkflowDraft({
          project,
          packageId: pkg.packageId,
          requirement: firstRequirement,
          successMeasures: pkg.successMeasures,
        });
        const rivalId = randomUUID();
        engine.workflows.set(rivalId, {
          id: rivalId,
          name: rivalDraft.name,
          description: rivalDraft.description,
          status: "draft",
          environment: project.environment,
          trigger_type: "manual",
          trigger_config: rivalDraft.trigger_config,
          created_by: "intake-skeleton",
          nodes: rivalDraft.nodes.map((n) => ({ ...n })),
          edges: rivalDraft.edges.map((e) => ({ ...e })),
        });
      }
      return engine.db(strings, ...values);
    }) as unknown as NeonClient;

    const result = await ensureUseCaseWorkflows(racingDb, project);
    expect(result.created).toHaveLength(2);
    expect(result.existing).toHaveLength(1);
    expect(result.existing[0].requirementCode).toBe(firstRequirement.code);
    expect(engine.workflows.size).toBe(3);
  });

  it("repairs a partial skeleton left by a create that died mid-graph (Codex on PR #60)", async () => {
    const engine = makeEngine();
    const pkg = donddentalPackage();
    const project = seedProject(engine, pkg);
    const requirement = pkg.requirementBaseline.requirements[0];
    const draft = buildUseCaseWorkflowDraft({
      project,
      packageId: pkg.packageId,
      requirement,
      successMeasures: pkg.successMeasures,
    });
    const partialId = randomUUID();
    const orphanStamp = new Date(Date.now() - 5 * 60_000).toISOString();
    engine.workflows.set(partialId, {
      id: partialId,
      name: draft.name,
      description: draft.description,
      status: "draft",
      environment: project.environment,
      trigger_type: "manual",
      trigger_config: draft.trigger_config,
      created_by: "intake-skeleton",
      // Old and never updated: an abandoned orphan, not an
      // in-flight create.
      created_at: orphanStamp,
      updated_at: orphanStamp,
      // Only the trigger node landed before the failure; no edges.
      nodes: [{ ...draft.nodes[0] }],
      edges: [],
    });

    const result = await ensureUseCaseWorkflows(engine.db, project);
    expect(result.created).toHaveLength(3);
    expect(engine.workflows.has(partialId)).toBe(false);
    const repaired = [...engine.workflows.values()].find(
      (w) => w.trigger_config.requirementCode === requirement.code,
    );
    expect(repaired?.nodes).toHaveLength(4);
    expect(repaired?.edges).toHaveLength(3);
  });

  it("creates skeletons only for human-validated requirements (Codex round 2 on PR #60)", async () => {
    const engine = makeEngine();
    const req = (overrides: Partial<HandoffRequirement>) =>
      ({
        id: randomUUID(),
        opportunityId: randomUUID(),
        code: "UC-SOME-USE-CASE",
        statement: "The business will automate a recurring manual process.",
        priority: "should",
        status: "draft",
        acceptanceCriteria: ["The process completes without manual steps"],
        blockingQuestions: [],
        ...overrides,
      }) as HandoffRequirement;
    const pkg = signTestPackage(
      packageBase({
        requirementBaseline: {
          version: 1,
          requirements: [
            req({ status: "draft" }),
            req({ status: "validated" }),
            req({
              status: "needs_clarification",
              humanValidatorId: "reviewer-1",
            }),
            req({ status: "validated", humanValidatorId: "reviewer-1" }),
          ],
          features: [],
        },
        successMeasures: [],
      }),
    ).pkg;
    const project = seedProject(engine, pkg);

    const result = await ensureUseCaseWorkflows(engine.db, project);
    // The freeze gate validates Must requirements only; a valid
    // package can carry the first three shapes, and none of them may
    // be presented as approved by a workflow or a client email.
    expect(result.created).toHaveLength(1);
    expect(engine.workflows.size).toBe(1);
    expect(
      isGeneratableRequirement(
        req({ status: "validated", humanValidatorId: "reviewer-1" }),
      ),
    ).toBe(true);
    expect(isGeneratableRequirement(req({ status: "validated" }))).toBe(false);
    expect(
      isGeneratableRequirement(
        req({ status: "proposed", humanValidatorId: "reviewer-1" }),
      ),
    ).toBe(false);
  });

  it("keys skeletons by requirement id — duplicate codes get one each (Codex round 2)", async () => {
    const engine = makeEngine();
    const mkReq = () =>
      ({
        id: randomUUID(),
        opportunityId: randomUUID(),
        // LE derives codes by truncating slugs: two distinct use
        // cases can legitimately share this code.
        code: "UC-AUTOMATED-APPOINTMENT-REMINDER-SYSTE",
        statement: "The business will automate appointment reminders.",
        priority: "must",
        status: "validated",
        humanValidatorId: "reviewer-1",
        acceptanceCriteria: ["Reminders send automatically"],
        blockingQuestions: [],
      }) as HandoffRequirement;
    const pkg = signTestPackage(
      packageBase({
        requirementBaseline: {
          version: 1,
          requirements: [mkReq(), mkReq()],
          features: [],
        },
        successMeasures: [],
      }),
    ).pkg;
    const project = seedProject(engine, pkg);

    const result = await ensureUseCaseWorkflows(engine.db, project);
    expect(result.created).toHaveLength(2);
    expect(engine.workflows.size).toBe(2);
    const ids = [...engine.workflows.values()].map(
      (w) => w.trigger_config.requirementId,
    );
    expect(new Set(ids).size).toBe(2);
  });

  it("never erases an operator's live-tested draft, however non-canonical (Codex round 2)", async () => {
    const engine = makeEngine();
    const pkg = donddentalPackage();
    const project = seedProject(engine, pkg);
    const requirement = pkg.requirementBaseline.requirements[0];
    const draft = buildUseCaseWorkflowDraft({
      project,
      packageId: pkg.packageId,
      requirement,
      successMeasures: pkg.successMeasures,
    });
    const editedId = randomUUID();
    engine.workflows.set(editedId, {
      id: editedId,
      name: draft.name,
      description: draft.description,
      status: "draft",
      environment: project.environment,
      trigger_type: "manual",
      trigger_config: draft.trigger_config,
      created_by: "intake-skeleton",
      // The operator removed two nodes while customizing the draft…
      nodes: [{ ...draft.nodes[0] }, { ...draft.nodes[1] }],
      edges: [{ ...draft.edges[0] }],
    });
    // …and live-tested it: a run exists.
    engine.runs.push({ workflow_id: editedId });

    const result = await ensureUseCaseWorkflows(engine.db, project);
    // The edited draft is reported, not replaced; the other two
    // requirements still get their skeletons.
    expect(result.existing.map((s) => s.id)).toContain(editedId);
    expect(result.created).toHaveLength(2);
    expect(engine.workflows.get(editedId)?.nodes).toHaveLength(2);
  });

  it("never treats a just-edited manual-route draft as repairable, however fresh (Codex round 3)", async () => {
    const engine = makeEngine();
    const pkg = donddentalPackage();
    const project = seedProject(engine, pkg);
    const requirement = pkg.requirementBaseline.requirements[0];
    const draft = buildUseCaseWorkflowDraft({
      project,
      packageId: pkg.packageId,
      requirement,
      successMeasures: pkg.successMeasures,
    });
    const now = Date.now();
    const editedId = randomUUID();
    engine.workflows.set(editedId, {
      id: editedId,
      name: draft.name,
      description: draft.description,
      status: "draft",
      environment: project.environment,
      trigger_type: "manual",
      trigger_config: draft.trigger_config,
      // Created through the Charter route a minute ago, then edited
      // thirty seconds later: freshness is not abandonment — the
      // trg_workflows_touch marker (updated_at) is what decides.
      created_by: "operator@example.com",
      created_at: new Date(now - 60_000).toISOString(),
      updated_at: new Date(now - 30_000).toISOString(),
      nodes: [{ ...draft.nodes[0] }, { ...draft.nodes[1] }],
      edges: [{ ...draft.edges[0] }],
    });

    const result = await ensureUseCaseWorkflows(engine.db, project, {
      createdBy: "operator@example.com",
    });
    expect(result.existing.map((s) => s.id)).toContain(editedId);
    expect(engine.workflows.get(editedId)?.nodes).toHaveLength(2);
    expect(result.created).toHaveLength(2);
  });

  it("protects a draft edited a single millisecond after creation (Codex round 4)", async () => {
    const engine = makeEngine();
    const pkg = donddentalPackage();
    const project = seedProject(engine, pkg);
    const requirement = pkg.requirementBaseline.requirements[0];
    const draft = buildUseCaseWorkflowDraft({
      project,
      packageId: pkg.packageId,
      requirement,
      successMeasures: pkg.successMeasures,
    });
    const created = Date.parse("2026-10-14T12:00:00.000Z");
    const editedId = randomUUID();
    engine.workflows.set(editedId, {
      id: editedId,
      name: draft.name,
      description: draft.description,
      status: "draft",
      environment: project.environment,
      trigger_type: "manual",
      trigger_config: draft.trigger_config,
      created_by: "operator@example.com",
      created_at: new Date(created).toISOString(),
      // Any positive delta is an update: Postgres stamps both
      // columns from one transaction now(), so exact equality is
      // the only never-updated state.
      updated_at: new Date(created + 1).toISOString(),
      nodes: [{ ...draft.nodes[0] }],
      edges: [],
    });

    const result = await ensureUseCaseWorkflows(engine.db, project);
    expect(result.existing.map((s) => s.id)).toContain(editedId);
    expect(engine.workflows.get(editedId)?.nodes).toHaveLength(1);
  });

  it("never attributes a measure to a requirement (Codex rounds 5 and 8)", async () => {
    const engine = makeEngine();
    const mkReq = (overrides: Partial<HandoffRequirement>) =>
      ({
        id: randomUUID(),
        opportunityId: randomUUID(),
        code: "UC-PLACEHOLDER",
        statement: "The business will automate a recurring manual process.",
        priority: "must",
        status: "validated",
        humanValidatorId: "reviewer-1",
        acceptanceCriteria: ["The process completes without manual steps"],
        blockingQuestions: [],
        ...overrides,
      }) as HandoffRequirement;
    const pkg = signTestPackage(
      packageBase({
        requirementBaseline: {
          version: 1,
          requirements: [
            // Ungeneratable, FIRST in the baseline…
            mkReq({ code: "UC-FIRST-DRAFT", status: "draft" }),
            // …followed by the generatable one.
            mkReq({ code: "UC-SECOND-VALIDATED" }),
          ],
          features: [],
        },
        // One measure — positionally the FIRST requirement's.
        successMeasures: [
          {
            metric: "First requirement metric",
            target: "FIRST-REQUIREMENT-TARGET-TEXT",
          },
        ],
      }),
    ).pkg;
    const project = seedProject(engine, pkg);

    const result = await ensureUseCaseWorkflows(engine.db, project);
    expect(result.created).toHaveLength(1);
    expect(result.created[0].requirementCode).toBe("UC-SECOND-VALIDATED");
    // The v1 contract gives measures no requirement association,
    // so the measure may ride along ONLY as unattributed project
    // context — never as this requirement's own target (Codex
    // rounds 5 and 8).
    const stored = [...engine.workflows.values()][0];
    const aiNode = stored.nodes.find((n) => n.kind === "ai_assist");
    const prompt = JSON.stringify(aiNode?.config);
    expect(prompt).toContain("FIRST-REQUIREMENT-TARGET-TEXT");
    expect(prompt).toContain("not specific to this use case");
  });

  it("revalidates the untouched marker inside the delete (TOCTOU, Codex round 5)", async () => {
    const engine = makeEngine();
    const pkg = donddentalPackage();
    const project = seedProject(engine, pkg);
    const requirement = pkg.requirementBaseline.requirements[0];
    const draft = buildUseCaseWorkflowDraft({
      project,
      packageId: pkg.packageId,
      requirement,
      successMeasures: pkg.successMeasures,
    });
    const partialId = randomUUID();
    const orphanStamp = new Date(Date.now() - 5 * 60_000).toISOString();
    engine.workflows.set(partialId, {
      id: partialId,
      name: draft.name,
      description: draft.description,
      status: "draft",
      environment: project.environment,
      trigger_type: "manual",
      trigger_config: draft.trigger_config,
      created_by: "intake-skeleton",
      created_at: orphanStamp,
      updated_at: orphanStamp,
      nodes: [{ ...draft.nodes[0] }],
      edges: [],
    });

    // The operator's save lands between the assessment and the
    // delete: bump updated_at just as the guarded delete arrives.
    let saved = false;
    const racingDb = (async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      if (!saved && strings[0].includes("delete from public.workflows")) {
        saved = true;
        const row = engine.workflows.get(partialId);
        if (row) {
          row.created_at = new Date(Date.now() - 60_000).toISOString();
          row.updated_at = new Date().toISOString();
        }
      }
      return engine.db(strings, ...values);
    }) as unknown as NeonClient;

    const result = await ensureUseCaseWorkflows(racingDb, project);
    // The guarded delete refused: the draft survives and is
    // reported as existing; the other requirements still generate.
    expect(result.existing.map((s) => s.id)).toContain(partialId);
    expect(engine.workflows.get(partialId)?.nodes).toHaveLength(1);
    expect(result.created).toHaveLength(2);
  });

  it("retries its OWN partial row within the same call (Codex round 7)", async () => {
    const engine = makeEngine();
    const pkg = donddentalPackage();
    const project = seedProject(engine, pkg);
    const firstCode = pkg.requirementBaseline.requirements[0].code;

    // The first node write of the whole run fails (a transient DB
    // error) AFTER the workflow row insert landed: the classic
    // mid-graph failure, on OUR OWN create.
    let failed = false;
    const flakyDb = (async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      if (!failed && strings[0].includes("insert into public.workflow_nodes")) {
        failed = true;
        throw new Error("simulated transient node-write failure");
      }
      return engine.db(strings, ...values);
    }) as unknown as NeonClient;

    const result = await ensureUseCaseWorkflows(flakyDb, project);
    // The partial was recognized as our own, removed, and retried —
    // not adopted as a finished skeleton.
    expect(result.created.map((s) => s.requirementCode)).toContain(firstCode);
    expect(result.existing).toHaveLength(0);
    const stored = [...engine.workflows.values()].filter(
      (w) => w.trigger_config.requirementCode === firstCode,
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].nodes).toHaveLength(4);
    expect(stored[0].edges).toHaveLength(3);
  });

  it("never deletes a skeleton another generator may still be building (Codex round 6)", async () => {
    const engine = makeEngine();
    const pkg = donddentalPackage();
    const project = seedProject(engine, pkg);
    const requirement = pkg.requirementBaseline.requirements[0];
    const draft = buildUseCaseWorkflowDraft({
      project,
      packageId: pkg.packageId,
      requirement,
      successMeasures: pkg.successMeasures,
    });
    const inFlightId = randomUUID();
    const young = new Date(Date.now() - 5_000).toISOString();
    engine.workflows.set(inFlightId, {
      id: inFlightId,
      name: draft.name,
      description: draft.description,
      status: "draft",
      environment: project.environment,
      trigger_type: "manual",
      trigger_config: draft.trigger_config,
      created_by: "intake-skeleton",
      // Row inserted five seconds ago; its graph writes may still
      // be landing. Never updated, zero runs — but NOT abandoned.
      created_at: young,
      updated_at: young,
      nodes: [{ ...draft.nodes[0] }],
      edges: [],
    });

    const first = await ensureUseCaseWorkflows(engine.db, project);
    // Adopted as existing, not deleted, not duplicated.
    expect(first.existing.map((s) => s.id)).toContain(inFlightId);
    expect(engine.workflows.get(inFlightId)?.nodes).toHaveLength(1);
    expect(first.created).toHaveLength(2);

    // Once the row is old, the same state reads as an abandoned
    // orphan and IS repaired.
    const stored = engine.workflows.get(inFlightId);
    if (stored) {
      const old = new Date(Date.now() - 5 * 60_000).toISOString();
      stored.created_at = old;
      stored.updated_at = old;
    }
    const second = await ensureUseCaseWorkflows(engine.db, project);
    expect(second.created.map((s) => s.requirementCode)).toContain(
      requirement.code,
    );
    expect(engine.workflows.has(inFlightId)).toBe(false);
    const repaired = [...engine.workflows.values()].find(
      (w) => w.trigger_config.requirementId === requirement.id,
    );
    expect(repaired?.nodes).toHaveLength(4);
  });

  it("creates nothing for an empty baseline, a rejected-only baseline, or no package", async () => {
    const engine = makeEngine();

    const emptyPkg = signTestPackage(
      packageBase({
        requirementBaseline: { version: 1, requirements: [], features: [] },
      }),
    ).pkg;
    const emptyProject = seedProject(engine, emptyPkg);
    expect(await ensureUseCaseWorkflows(engine.db, emptyProject)).toEqual({
      created: [],
      existing: [],
    });

    const rejectedPkg = signTestPackage(
      packageBase({
        requirementBaseline: {
          version: 1,
          requirements: [
            {
              id: randomUUID(),
              opportunityId: randomUUID(),
              code: "UC-REJECTED-THING",
              statement: "This requirement was rejected by the reviewer.",
              priority: "could",
              status: "rejected",
              acceptanceCriteria: [],
              blockingQuestions: [],
            },
          ],
          features: [],
        },
      }),
    ).pkg;
    const rejectedProject = seedProject(engine, rejectedPkg);
    expect(await ensureUseCaseWorkflows(engine.db, rejectedProject)).toEqual({
      created: [],
      existing: [],
    });

    const orphan: UseCaseWorkflowProjectRef = {
      id: randomUUID(),
      environment: "production",
      package_id: randomUUID(),
      organization_name: "No Package Co",
    };
    expect(await ensureUseCaseWorkflows(engine.db, orphan)).toEqual({
      created: [],
      existing: [],
    });
    expect(engine.workflows.size).toBe(0);
  });

  it("claims no success-measure pairing when the counts do not align", async () => {
    const draft = buildUseCaseWorkflowDraft({
      project: {
        id: randomUUID(),
        environment: "production",
        package_id: randomUUID(),
        organization_name: "Acme Corp",
      },
      packageId: randomUUID(),
      requirement: {
        id: randomUUID(),
        opportunityId: randomUUID(),
        code: "UC-INVOICE-RECONCILIATION",
        statement: "The system must automate invoice reconciliation.",
        priority: "must",
        status: "validated",
        acceptanceCriteria: ["Reconciliation completes without manual steps"],
        blockingQuestions: [],
      },
    });
    const ai = draft.nodes.find((n) => n.kind === "ai_assist");
    expect(String(ai?.config.userPrompt ?? "")).not.toContain(
      "Success measure:",
    );
  });
});

/* ── intake wrapper (fail-open) ──────────────────────────────────────── */

describe("generateUseCaseWorkflowsForAcceptedPackage", () => {
  it("generates skeletons for the project a package produced", async () => {
    const engine = makeEngine();
    const pkg = donddentalPackage();
    seedProject(engine, pkg);

    const result = await generateUseCaseWorkflowsForAcceptedPackage(
      engine.db,
      pkg,
      "production",
    );
    expect(result?.created).toHaveLength(3);
    expect(engine.workflows.size).toBe(3);
  });

  it("prefers the just-created project id over the ambiguous package lookup (Codex round 9)", async () => {
    const engine = makeEngine();
    const pkg = donddentalPackage();
    // An earlier package version created a project under the SAME
    // packageId; the package-only lookup resolves to it.
    const oldProject = seedProject(engine, pkg);
    // The new version's accept created a second project; intake
    // knows its id and passes it explicitly.
    const newProject: UseCaseWorkflowProjectRef = {
      id: randomUUID(),
      environment: "production",
      package_id: pkg.packageId,
      organization_name: "Donddental",
    };
    engine.projectRows.set(newProject.id, newProject);
    engine.packages.set(newProject.id, pkg);

    const result = await generateUseCaseWorkflowsForAcceptedPackage(
      engine.db,
      pkg,
      "production",
      newProject.id,
    );
    expect(result?.created).toHaveLength(3);
    const owners = new Set(
      [...engine.workflows.values()].map(
        (w) => w.trigger_config.projectId,
      ),
    );
    expect(owners).toEqual(new Set([newProject.id]));
    expect(owners.has(oldProject.id)).toBe(false);
  });

  it("returns null (never throws) when the database fails", async () => {
    const throwingDb = (async () => {
      throw new Error("connection reset");
    }) as unknown as NeonClient;
    await expect(
      generateUseCaseWorkflowsForAcceptedPackage(
        throwingDb,
        donddentalPackage(),
        "production",
      ),
    ).resolves.toBeNull();
  });

  it("returns null when no project exists for the package", async () => {
    const engine = makeEngine();
    await expect(
      generateUseCaseWorkflowsForAcceptedPackage(
        engine.db,
        donddentalPackage(),
        "production",
      ),
    ).resolves.toBeNull();
    expect(engine.workflows.size).toBe(0);
  });
});

/* ── wiring contracts ────────────────────────────────────────────────── */

describe("skeleton wiring", () => {
  it("the intake hook generates skeletons before the trigger fires", () => {
    const intake = readFileSync(
      new URL("../api/intake.ts", import.meta.url),
      "utf8",
    );
    expect(intake).toContain("generateUseCaseWorkflowsForAcceptedPackage");
    expect(intake).toContain("triggerLeadHandoffWorkflows");
    expect(
      intake.indexOf("generateUseCaseWorkflowsForAcceptedPackage"),
    ).toBeLessThan(intake.indexOf("await triggerLeadHandoffWorkflows"));
  });

  it("the Charter offers skeleton generation and lists skeletons", () => {
    const charter = readFileSync(
      new URL("../src/charter.tsx", import.meta.url),
      "utf8",
    );
    expect(charter).toContain("Create use-case workflows");
    expect(charter).toContain("/workflow-skeletons");
    expect(charter).toContain("Use-case workflows");
    expect(charter).toContain("useCaseWorkflows");
    // Partial success keeps the action available (Codex round 3),
    // counted in COMPLETE skeletons so an incomplete row cannot
    // hide the repair path (round 8).
    expect(charter).toContain(
      "useCaseWorkflowCompleteCount < state.requirementCount",
    );
  });

  it("the route is registered in the project dispatcher", () => {
    const dispatch = readFileSync(
      new URL("../api/pj-dispatch.ts", import.meta.url),
      "utf8",
    );
    expect(dispatch).toContain("workflow-skeletons");
    expect(dispatch).toContain("workflowSkeletonsHandler");
  });
});
