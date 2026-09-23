#!/usr/bin/env node
/**
 * Synthetic end-to-end orchestration test: Lead Engine <-> Delivery Factory.
 *
 * Exercises the full production integration with clearly-labeled synthetic
 * data, then cleans everything up:
 *
 *   LE:  insert synthetic org + opportunity
 *        -> buildHandoffPackage (real LE function)
 *        -> dispatchDueHandoffs (real LE dispatcher) -> DF /api/intake
 *   DF:  verify stored in handoff_inbox + delivery_projects
 *        -> dispatchDueFeedback (real DF dispatcher) -> LE /api/v1/feedback/events
 *   LE:  verify feedback stored in delivery_feedback_events
 *   ALL: cleanup synthetic rows from both databases
 *
 * Known product gap (documented, not a test failure): buildHandoffPackage
 * emits an EMPTY requirement baseline, which DF rejects with 422 per the
 * Must-requirement freeze rule. The script proves the transport with the
 * empty package (expecting 422), then proves acceptance with an augmented
 * package carrying a synthetic human-validated Must requirement (expecting
 * 201) — simulating the pending human-validated requirements workflow.
 *
 * NOTE: DF production /api/intake currently 401s every signed package
 * because readIntakeEnv does not normalize literal \n in
 * LEAD_ENGINE_PUBLIC_KEY_PEM (fix written, awaiting deployment). Until that
 * deploys, intake steps will FAIL with 401 and the script reports it.
 *
 * Usage:
 *   python3 /tmp/fetch-e2e-secrets.py /tmp/e2e-secrets.json
 *   pnpm tsx scripts/synthetic-e2e.mts /tmp/e2e-secrets.json
 *
 * Never prints secrets.
 */
import { readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "../apps/leads-engine/api/_lib/neon.js";
import {
  buildHandoffPackage,
  dispatchDueHandoffs,
} from "../apps/leads-engine/api/_lib/handoff.js";
import {
  createNeonFeedbackOutboxStore,
  dispatchDueFeedback,
} from "../apps/delivery-factory/api/_lib/feedback-dispatch.js";
import { getDb as getDeliveryDb } from "../apps/delivery-factory/api/_lib/db.js";
import {
  canonicalJsonStringify,
  signPackage,
  LeadEngineHandoffPackageSchema,
} from "/home/hatch/workspace/d-raphah/packages/handoff-contract/dist/index.js";

const secretsPath = process.argv[2] ?? "/tmp/e2e-secrets.json";
const secrets = JSON.parse(readFileSync(secretsPath, "utf8"));

// Wire production env (in memory only).
process.env.HANDOFF_SIGNING_PRIVATE_KEY_PEM = secrets.HANDOFF_SIGNING_PRIVATE_KEY_PEM;
process.env.HANDOFF_SIGNING_PUBLIC_KEY_PEM = secrets.HANDOFF_SIGNING_PUBLIC_KEY_PEM;
process.env.DELIVERY_INTAKE_URL =
  secrets.DELIVERY_INTAKE_URL?.startsWith("https://")
    ? secrets.DELIVERY_INTAKE_URL
    : "https://d-raphah-delivery-factory.vercel.app/api/intake";
process.env.DATABASE_URL = secrets.DATABASE_URL;
process.env.DELIVERY_DATABASE_URL = secrets.DELIVERY_DATABASE_URL;
const LEAD_ENGINE_BASE_URL = (secrets.LEAD_ENGINE_BASE_URL?.startsWith("https://")
  ? secrets.LEAD_ENGINE_BASE_URL
  : "https://d-raphah-leads-engine.vercel.app"
).replace(/\/$/, "");

const norm = (pem: string) => pem.replace(/\\n/g, "\n").trim();
const TAG = "SYNTHETIC-E2E";

const results: Array<{ step: string; status: "PASS" | "FAIL" | "EXPECTED"; detail: string }> = [];
const step = (name: string, status: "PASS" | "FAIL" | "EXPECTED", detail = "") => {
  results.push({ step: name, status, detail });
  console.log(`${status}  ${name}${detail ? " — " + detail : ""}`);
};

const le = createAdminClient();
const df = getDeliveryDb();

let workspaceId = "";
let syntheticWorkspace = false;
let orgId = "";
let oppId = "";
let outboxId1 = "";
let outboxId2 = "";
let dfProjectId: string | null = null;
let dfInboxId: string | null = null;
let feedbackEventId = "";

async function cleanup() {
  console.log("\n--- cleanup ---");
  try {
    // DF side (reverse FK order).
    if (dfProjectId) {
      await df`delete from public.feedback_outbox where project_id = ${dfProjectId}::uuid`;
      await df`delete from public.stage_history where project_id = ${dfProjectId}::uuid`;
      await df`delete from public.milestones where project_id = ${dfProjectId}::uuid`;
      await df`delete from public.delivery_projects where id = ${dfProjectId}::uuid`;
    }
    if (dfInboxId) {
      await df`delete from public.handoff_inbox where id = ${dfInboxId}::uuid`;
    }
    // LE side (reverse FK order).
    if (oppId) {
      await le`delete from public.delivery_feedback_events where opportunity_id = ${oppId}::uuid`;
      await le`delete from public.handoff_outbox where workspace_id = ${workspaceId}::uuid and idempotency_key like ${TAG + "%"}`;
      await le`delete from public.opportunities where id = ${oppId}::uuid`;
    }
    if (orgId) {
      await le`delete from public.organizations where id = ${orgId}::uuid`;
    }
    if (syntheticWorkspace && workspaceId) {
      await le`delete from public.workspaces where id = ${workspaceId}::uuid`;
    }
    // Verify clean.
    const leftovers = (await le`
      select count(*)::int as c from public.opportunities
      where id = ${oppId}::uuid
    `) as Array<{ c: number }>;
    step("cleanup: synthetic rows removed", leftovers[0].c === 0 ? "PASS" : "FAIL");
  } catch (e) {
    step("cleanup: synthetic rows removed", "FAIL", e instanceof Error ? e.message : String(e));
  }
}

try {
  // ── Setup: find or create a synthetic workspace ────────────────────
  const workspaces = (await le`
    select id from public.workspaces order by created_at limit 1
  `) as Array<{ id: string }>;
  if (workspaces.length === 0) {
    workspaceId = randomUUID();
    await le`
      insert into public.workspaces(id, name, created_by)
      values (${workspaceId}::uuid, ${`${TAG} Test Workspace`}, ${`${TAG.toLowerCase()}-e2e`})
    `;
    syntheticWorkspace = true;
    step("setup: synthetic LE workspace created", "PASS");
  } else {
    workspaceId = workspaces[0].id;
    step("setup: LE workspace found", "PASS");
  }

  // ── Step 1: synthetic organization + opportunity ──────────────────────
  orgId = randomUUID();
  oppId = randomUUID();
  await le`
    insert into public.organizations(
      id, workspace_id, name, normalized_name, normalized_domain, website_url
    ) values (
      ${orgId}::uuid, ${workspaceId}::uuid,
      ${`${TAG} Test Org`}, ${`${TAG.toLowerCase()}-test-org`},
      ${"synthetic-e2e.invalid"}, ${"https://synthetic-e2e.invalid"}
    )
  `;
  await le`
    insert into public.opportunities(
      id, workspace_id, organization_id, title, stage, routing, status,
      automation_maturity_score, opportunity_potential_score, confidence,
      last_refreshed_at
    ) values (
      ${oppId}::uuid, ${workspaceId}::uuid, ${orgId}::uuid,
      ${`${TAG}: synthetic opportunity for E2E orchestration`},
      'detected', 'standard_review', 'active', 42, 70, 0.85, now()
    )
  `;
  step("1: synthetic org + opportunity created in LE", "PASS", `opp=${oppId.slice(0, 8)}…`);

  // ── Step 2: build handoff package with the real LE function ──────────
  const built = await buildHandoffPackage(le as never, {
    workspaceId,
    opportunityId: oppId,
    approvedBy: `${TAG.toLowerCase()}-orchestration`,
  });
  step(
    "2: buildHandoffPackage produced schema-valid package",
    "PASS",
    `pkg=${built.package.packageId.slice(0, 8)}… baseline_requirements=${built.package.requirementBaseline.requirements.length}`,
  );

  // ── Step 3: dispatch the empty-baseline package (expect 422) ─────────
  const idem1 = `${TAG}:${randomUUID()}`;
  const outbox1 = (await le`
    insert into public.handoff_outbox(
      workspace_id, idempotency_key, package, manifest_checksum, signature, status
    ) values (
      ${workspaceId}::uuid, ${idem1}, ${JSON.stringify(built.package)}::jsonb,
      ${built.manifestChecksum}, ${built.signature}, 'pending'
    ) returning id
  `) as Array<{ id: string }>;
  outboxId1 = outbox1[0].id;
  const dispatch1 = await dispatchDueHandoffs(le as never);
  const row1 = (await le`
    select status, last_error from public.handoff_outbox where id = ${outboxId1}::uuid
  `) as Array<{ status: string; last_error: string | null }>;
  const err1 = row1[0]?.last_error ?? "";
  if (/422/.test(err1)) {
    step(
      "3: empty-baseline package rejected with 422 (known product gap)",
      "EXPECTED",
      "DF enforces the Must-requirement freeze rule; transport + signature path proven separately",
    );
  } else {
    step(
      "3: empty-baseline package dispatch",
      "FAIL",
      `status=${row1[0]?.status} error=${err1.slice(0, 120)}`,
    );
  }

  // ── Step 4: augmented package with human-validated requirement ───────
  const { manifestChecksum: _drop, ...unsigned } = built.package as Record<string, unknown>;
  const reqId = randomUUID();
  const augmented = {
    ...unsigned,
    requirementBaseline: {
      version: 1,
      requirements: [
        {
          id: reqId,
          opportunityId: oppId,
          code: `${TAG}-REQ-001`,
          statement: "Synthetic human-validated requirement for E2E orchestration.",
          priority: "must",
          status: "validated",
          humanValidatorId: `${TAG.toLowerCase()}-validator`,
          acceptanceCriteria: ["Handoff accepted by Delivery Factory intake"],
          blockingQuestions: [],
        },
      ],
      features: [],
    },
  };
  const { manifestChecksum, signature } = signPackage(
    augmented,
    norm(secrets.HANDOFF_SIGNING_PRIVATE_KEY_PEM),
  );
  const pkg = LeadEngineHandoffPackageSchema.parse({ ...augmented, manifestChecksum });
  const idem2 = `${TAG}:${randomUUID()}`;
  const outbox2 = (await le`
    insert into public.handoff_outbox(
      workspace_id, idempotency_key, package, manifest_checksum, signature, status
    ) values (
      ${workspaceId}::uuid, ${idem2}, ${JSON.stringify(pkg)}::jsonb,
      ${manifestChecksum}, ${signature}, 'pending'
    ) returning id
  `) as Array<{ id: string }>;
  outboxId2 = outbox2[0].id;
  const dispatch2 = await dispatchDueHandoffs(le as never);
  const row2 = (await le`
    select status, last_error, dispatched_at from public.handoff_outbox where id = ${outboxId2}::uuid
  `) as Array<{ status: string; last_error: string | null; dispatched_at: string | null }>;
  step(
    "4: dispatchDueHandoffs delivered acceptable package",
    row2[0]?.status === "sent" ? "PASS" : "FAIL",
    `status=${row2[0]?.status} dispatched=${dispatch2.dispatched} error=${(row2[0]?.last_error ?? "").slice(0, 120)}`,
  );

  // ── Step 5: verify stored in DF ──────────────────────────────────────
  const inbox = (await df`
    select i.id, i.status, p.id as project_id, p.current_stage
    from public.handoff_inbox i
    left join public.delivery_projects p on p.inbox_id = i.id
    where i.idempotency_key = ${idem2}
  `) as Array<{ id: string; status: string; project_id: string | null; current_stage: string | null }>;
  dfInboxId = inbox[0]?.id ?? null;
  dfProjectId = inbox[0]?.project_id ?? null;
  step(
    "5: package stored in DF handoff_inbox + project created",
    inbox.length === 1 && !!dfProjectId ? "PASS" : "FAIL",
    `inbox=${inbox.length} project=${dfProjectId?.slice(0, 8) ?? "none"}…`,
  );

  // ── Step 6: dispatch feedback DF -> LE ───────────────────────────────
  const fbSummary = await dispatchDueFeedback({
    store: createNeonFeedbackOutboxStore(getDeliveryDb()),
    env: {
      leadEngineBaseUrl: LEAD_ENGINE_BASE_URL,
      signingPrivateKeyPem: norm(secrets.FEEDBACK_SIGNING_PRIVATE_KEY_PEM),
    },
  });
  step(
    "6: dispatchDueFeedback delivered feedback to LE",
    fbSummary.sent >= 1 ? "PASS" : "FAIL",
    `claimed=${fbSummary.claimed} sent=${fbSummary.sent} failed=${fbSummary.failed}`,
  );

  // ── Step 7: verify feedback stored in LE ──────────────────────────────
  // Give LE a moment if dispatch was async (it is awaited, so immediate).
  const fbEvents = (await le`
    select event_id, event_type from public.delivery_feedback_events
    where opportunity_id = ${oppId}::uuid
    order by occurred_at desc limit 5
  `) as Array<{ event_id: string; event_type: string }>;
  feedbackEventId = fbEvents[0]?.event_id ?? "";
  step(
    "7: feedback event stored in LE delivery_feedback_events",
    fbEvents.length >= 1 ? "PASS" : "FAIL",
    `events=${fbEvents.length} type=${fbEvents[0]?.event_type ?? "none"}`,
  );
} catch (e) {
  step("orchestration completed without exception", "FAIL", e instanceof Error ? e.message : String(e));
} finally {
  await cleanup();
  try {
    unlinkSync(secretsPath);
    console.log("secrets file deleted");
  } catch {}
}

const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`\n=== ${results.length - failed}/${results.length} steps ok (${failed} failed) ===`);
process.exit(failed > 0 ? 1 : 0);
