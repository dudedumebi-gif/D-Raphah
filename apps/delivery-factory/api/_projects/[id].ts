import { getProjectDetail } from "../_lib/projects.js";
import { defineRoute } from "../_lib/route.js";
import { routeParam, sendJson } from "../_lib/http.js";

/** GET /api/projects/:id — full project detail with milestones and clarifications. */
export default defineRoute(["GET"], async (req, res, { db }) => {
  const id = routeParam(req, "id");
  if (!id) {
    sendJson(res, 400, {}, { error: "Project id is required" });
    return;
  }
  const detail = await getProjectDetail(db, id);
  sendJson(res, 200, {}, detail);
});
