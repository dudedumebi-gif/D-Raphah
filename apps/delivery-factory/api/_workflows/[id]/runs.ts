import { defineRoute } from "../../_lib/route.js";
import { getDb } from "../../_lib/db.js";
import { routeParam, sendJson } from "../../_lib/http.js";
import { listRuns } from "../../_lib/workflows.js";

/** GET /api/workflows/:id/runs — execution history for a workflow. */
export default defineRoute(["GET"], async (req, res) => { const db = getDb();
  const id = routeParam(req, "id");
  if (!id) {
    sendJson(res, 400, {}, { error: "Workflow id is required" });
    return;
  }
  const runs = await listRuns(db, id);
  sendJson(res, 200, {}, { runs });
});
