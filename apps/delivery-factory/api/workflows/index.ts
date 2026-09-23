import { defineRoute } from "../_lib/route.js";
import { getDb } from "../_lib/db.js";
import { readJsonBody, sendJson } from "../_lib/http.js";
import { createWorkflow, listWorkflows } from "../_lib/workflows.js";

/** GET /api/workflows — list (without graph). POST /api/workflows — create. */
export default defineRoute(["GET", "POST"], async (req, res) => { const db = getDb();
  if (req.method === "GET") {
    sendJson(res, 200, {}, { workflows: await listWorkflows(db) });
    return;
  }
  const body = (await readJsonBody(req)) as Record<string, unknown>;
  if (!body || typeof body.name !== "string" || !body.name.trim()) {
    sendJson(res, 400, {}, { error: "name is required" });
    return;
  }
  const wf = await createWorkflow(db, {
    name: body.name.trim(),
    description: typeof body.description === "string" ? body.description : undefined,
    trigger_type: (body.trigger_type as "manual") ?? "manual",
    trigger_config: (body.trigger_config ?? {}) as Record<string, unknown>,
    nodes: (body.nodes ?? []) as [],
    edges: (body.edges ?? []) as [],
  });
  sendJson(res, 201, {}, { workflow: wf });
});
