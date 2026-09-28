import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../neon/migrations/202609270001_delivery_audit.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("Delivery Factory audit migration", () => {
  it("audits every business-state table and advances the schema", () => {
    for (const table of [
      "handoff_inbox",
      "delivery_projects",
      "stage_history",
      "milestones",
      "clarifications",
      "feedback_outbox",
      "workflows",
      "workflow_nodes",
      "workflow_edges",
      "workflow_runs",
      "workflow_run_steps",
    ])
      expect(migration).toContain(`'${table}'`);
    expect(migration).toContain("capture_delivery_audit_event");
    expect(migration).toContain("'1.1.0'");
  });

  it("keeps the audit stream immutable to browser roles", () => {
    expect(migration).toContain("enable row level security");
    expect(migration).toContain("revoke insert,update,delete");
  });
});
