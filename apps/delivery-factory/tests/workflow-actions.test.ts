import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { NeonClient } from "../api/_lib/db.js";
import { archiveWorkflow, deleteWorkflow } from "../api/_lib/workflows.js";

/**
 * Workflow retire actions (user request, 2026-10-14): two stray
 * "Untitled workflow" drafts in the Production scope could not be
 * removed because the Automations UI exposed no Archive/Delete,
 * even though the API has always supported both. Pins the lib
 * semantics the UI relies on (archive = status flip; delete = hard
 * delete reporting existence), the route dispatch, and the UI
 * wiring with its status gating.
 */

function makeDb(row: Record<string, unknown> | null) {
  const state = { row: row ? { ...row } : null, deleted: false };
  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const head = strings.join(" ");
    if (head.includes("delete from public.workflows")) {
      if (!state.row) return [];
      state.deleted = true;
      return [{ id: values[0] }];
    }
    if (head.includes("update public.workflows")) {
      if (state.row) state.row.status = "archived";
      return [];
    }
    if (head.includes("from public.workflow_nodes")) return [];
    if (head.includes("from public.workflow_edges")) return [];
    if (head.includes("from public.workflows")) {
      if (!state.row || state.deleted) return [];
      return [{ ...state.row }];
    }
    throw new Error(`Unexpected query: ${head.slice(0, 90)}`);
  }) as unknown as NeonClient;
  return { db, state };
}

const ROW = {
  id: "wf-1",
  name: "Untitled workflow",
  description: null,
  status: "draft",
  environment: "production",
  trigger_type: "manual",
  trigger_config: {},
  created_by: "seed",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  published_at: null,
};

describe("archive/delete workflow semantics", () => {
  it("archive flips the status to archived and returns the workflow", async () => {
    const { db, state } = makeDb(ROW);
    const wf = await archiveWorkflow(db, "wf-1");
    expect(state.row?.status).toBe("archived");
    expect(wf?.status).toBe("archived");
  });

  it("delete removes the row and reports existence honestly", async () => {
    const { db } = makeDb(ROW);
    await expect(deleteWorkflow(db, "wf-1")).resolves.toBe(true);
    const empty = makeDb(null);
    await expect(deleteWorkflow(empty.db, "wf-1")).resolves.toBe(false);
  });
});

describe("workflow retire wiring", () => {
  const route = readFileSync(
    new URL("../api/_workflows/[id].ts", import.meta.url),
    "utf8",
  );
  const ui = readFileSync(
    new URL("../src/workflows.tsx", import.meta.url),
    "utf8",
  );

  it("the route dispatches DELETE and the archive action", () => {
    expect(route).toContain("deleteWorkflow");
    expect(route).toContain('body?.action === "archive"');
    expect(route).toContain("archiveWorkflow");
  });

  it("the list and editor both expose archive + delete", () => {
    // One PUT {action:"archive"} in the list, one in the editor.
    expect(ui.split('action: "archive"').length - 1).toBe(2);
    expect(ui.split('method: "DELETE"').length - 1).toBe(2);
  });

  it("delete is confirm-gated and restricted to drafts/archived", () => {
    expect(ui).toContain("window.confirm");
    expect(ui).toContain('w.status === "draft" || w.status === "archived"');
    expect(ui).toContain('isDraft || workflow.status === "archived"');
    expect(ui).toContain('w.status !== "archived"');
  });
});
