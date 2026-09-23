import { defineRoute } from "../../_lib/route.js";
import { getDb } from "../../_lib/db.js";
import { routeParam, sendJson } from "../../_lib/http.js";
import { getRun } from "../../_lib/workflows.js";

/** GET /api/workflows/runs/:runId — run detail with per-node audit steps. */
export default defineRoute(["GET"], async (req, res) => { const db = getDb();
  const runId = routeParam(req, "runId");
  if (!runId) {
    sendJson(res, 400, {}, { error: "Run id is required" });
    return;
  }
  const run = await getRun(db, runId);
  if (!run) {
    sendJson(res, 404, {}, { error: "Run not found" });
    return;
  }
  sendJson(res, 200, {}, { run });
});
