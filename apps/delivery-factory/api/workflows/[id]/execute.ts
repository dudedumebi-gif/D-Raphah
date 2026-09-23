import { defineRoute } from "../../_lib/route.js";
import { getDb } from "../../_lib/db.js";
import { readJsonBody, routeParam, sendJson } from "../../_lib/http.js";
import { executeWorkflow } from "../../_lib/workflows.js";

/** POST /api/workflows/:id/execute — run a published workflow immediately. */
export default defineRoute(["POST"], async (req, res) => { const db = getDb();
  const id = routeParam(req, "id");
  if (!id) {
    sendJson(res, 400, {}, { error: "Workflow id is required" });
    return;
  }
  const body = ((await readJsonBody(req)) ?? {}) as Record<string, unknown>;
  const run = await executeWorkflow(
    db,
    id,
    (body.input ?? {}) as Record<string, unknown>,
  );
  sendJson(res, 200, {}, { run });
});
