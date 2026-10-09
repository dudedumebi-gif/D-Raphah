import { defineRoute } from "../_lib/route.js";
import { getDb, parseDeliveryEnvironment } from "../_lib/db.js";
import { readJsonBody, sendJson } from "../_lib/http.js";
import { createWorkflow, listWorkflows } from "../_lib/workflows.js";

/**
 * GET /api/workflows — list (without graph), optionally filtered to one
 * environment via ?environment=demo|production.
 * POST /api/workflows — create in the given environment (default
 * production); the environment is fixed at creation.
 */
export default defineRoute(["GET", "POST"], async (req, res) => { const db = getDb();
  if (req.method === "GET") {
    const rawEnvironment = req.query?.environment;
    if (rawEnvironment !== undefined && parseDeliveryEnvironment(rawEnvironment) === null) {
      sendJson(res, 400, {}, { error: "environment must be 'demo' or 'production'" });
      return;
    }
    const environment = parseDeliveryEnvironment(rawEnvironment) ?? undefined;
    sendJson(res, 200, {}, { workflows: await listWorkflows(db, environment) });
    return;
  }
  const body = (await readJsonBody(req)) as Record<string, unknown>;
  if (!body || typeof body.name !== "string" || !body.name.trim()) {
    sendJson(res, 400, {}, { error: "name is required" });
    return;
  }
  if (body.environment !== undefined && parseDeliveryEnvironment(body.environment) === null) {
    sendJson(res, 400, {}, { error: "environment must be 'demo' or 'production'" });
    return;
  }
  const wf = await createWorkflow(db, {
    name: body.name.trim(),
    description: typeof body.description === "string" ? body.description : undefined,
    environment: parseDeliveryEnvironment(body.environment) ?? "production",
    trigger_type: (body.trigger_type as "manual") ?? "manual",
    trigger_config: (body.trigger_config ?? {}) as Record<string, unknown>,
    nodes: (body.nodes ?? []) as [],
    edges: (body.edges ?? []) as [],
  });
  sendJson(res, 201, {}, { workflow: wf });
});
