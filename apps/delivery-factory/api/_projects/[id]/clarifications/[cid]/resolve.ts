import { settleClarification } from "../../../../_lib/projects.js";
import { defineRoute } from "../../../../_lib/route.js";
import { routeParam, sendJson } from "../../../../_lib/http.js";

/** POST /api/projects/:id/clarifications/:cid/resolve — resolve a clarification. */
export default defineRoute(["POST"], async (req, res, { db }) => {
  const id = routeParam(req, "id");
  const cid = routeParam(req, "cid");
  if (!id || !cid) {
    sendJson(res, 400, {}, { error: "Project id and clarification id are required" });
    return;
  }
  const clarification = await settleClarification(db, {
    projectId: id,
    clarificationId: cid,
  });
  sendJson(res, 200, {}, { clarification });
});
