import { randomUUID } from "node:crypto";
import type { LeadEngineHandoffPackage } from "@raphah/handoff-contract";
import { describe, expect, it } from "vitest";
import type { DeliveryEnvironment } from "../api/_lib/db.js";
import { handleIntake, type IntakeEnv } from "../api/_lib/verify.js";
import { listWorkflows } from "../api/_lib/workflows.js";
import { FakeDeliveryDb } from "./fake-db.js";
import { intakeRequest, signTestPackage, testEnv } from "./helpers.js";

/**
 * Phase 0 environment separation: demo and production are real scopes in
 * the data, not a UI badge. Intake stamps every accept with the scope
 * derived from the deployment environment; workflow lists filter by
 * scope; and the intake hook's skeleton generation runs inside the
 * scope a package was accepted into (covered with the hook's tests).
 */

describe("intake environment scope", () => {
  it("stamps production accepts as production, end to end", async () => {
    const db = new FakeDeliveryDb();
    const signed = signTestPackage();
    const seen: Array<{ pkg: LeadEngineHandoffPackage; environment: DeliveryEnvironment }> = [];
    const result = await handleIntake(
      intakeRequest(signed),
      db,
      testEnv({ environment: "production" }),
      {
        onHandoffAccepted: async (pkg, environment) => {
          seen.push({ pkg, environment });
        },
      },
    );
    expect(result.status).toBe(201);
    expect((result.body as { environment: string }).environment).toBe(
      "production",
    );
    const projectId = (result.body as { projectId: string }).projectId;
    const project = await db.getProject(projectId);
    expect(project?.environment).toBe("production");
    const inbox = await db.findInboxByIdempotencyKey(
      [...db.inboxes.keys()][0],
    );
    expect(inbox?.environment).toBe("production");
    expect(seen).toHaveLength(1);
    expect(seen[0].environment).toBe("production");
  });

  it("stamps non-production accepts as demo", async () => {
    const db = new FakeDeliveryDb();
    const signed = signTestPackage();
    const seen: DeliveryEnvironment[] = [];
    const result = await handleIntake(
      intakeRequest(signed),
      db,
      testEnv({ environment: "test" }),
      {
        onHandoffAccepted: async (_pkg, environment) => {
          seen.push(environment);
        },
      },
    );
    expect(result.status).toBe(201);
    expect((result.body as { environment: string }).environment).toBe("demo");
    const projectId = (result.body as { projectId: string }).projectId;
    expect((await db.getProject(projectId))?.environment).toBe("demo");
    expect(seen).toEqual(["demo"]);
  });

  it("reports the original scope on idempotent replay", async () => {
    const db = new FakeDeliveryDb();
    const signed = signTestPackage();
    const env: IntakeEnv = testEnv({ environment: "preview" });
    const first = await handleIntake(intakeRequest(signed), db, env);
    expect(first.status).toBe(201);
    const key = [...db.inboxes.keys()][0];
    const replay = await handleIntake(
      intakeRequest(signed, { "idempotency-key": key }),
      db,
      env,
    );
    expect(replay.status).toBe(200);
    expect((replay.body as { environment: string }).environment).toBe("demo");
  });
});

/* ── Workflow list filter ────────────────────────────────────────────── */

describe("workflow list environment filter", () => {
  const rows = [
    { id: randomUUID(), name: "Demo A", environment: "demo" },
    { id: randomUUID(), name: "Demo B", environment: "demo" },
    { id: randomUUID(), name: "Prod A", environment: "production" },
  ].map((r) => ({
    ...r,
    description: null,
    status: "draft",
    trigger_type: "manual",
    trigger_config: {},
    created_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    published_at: null,
  }));

  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings[0];
    if (head.includes("from public.workflows") && head.includes("where environment =")) {
      return rows.filter((r) => r.environment === String(values[0]));
    }
    if (head.includes("from public.workflows")) return rows;
    throw new Error(`Unexpected query: ${head.slice(0, 100)}`);
  }) as unknown as Parameters<typeof listWorkflows>[0];

  it("lists everything without a filter", async () => {
    expect(await listWorkflows(db)).toHaveLength(3);
  });

  it("filters to one environment", async () => {
    const demo = await listWorkflows(db, "demo");
    expect(demo.map((w) => w.name)).toEqual(["Demo A", "Demo B"]);
    expect(demo.every((w) => w.environment === "demo")).toBe(true);
    const prod = await listWorkflows(db, "production");
    expect(prod.map((w) => w.name)).toEqual(["Prod A"]);
  });
});
