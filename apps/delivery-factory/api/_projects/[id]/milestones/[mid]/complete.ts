import { finishMilestone } from "../../../../_lib/projects.js";
import { defineRoute } from "../../../../_lib/route.js";
import { routeParam, sendJson } from "../../../../_lib/http.js";

/** POST /api/projects/:id/milestones/:mid/complete — mark a milestone complete. */
export default defineRoute(["POST"], async (req, res, { db, env }) => {
  const id = routeParam(req, "id");
  const mid = routeParam(req, "mid");
  if (!id || !mid) {
    sendJson(res, 400, {}, { error: "Project id and milestone id are required" });
    return;
  }
  const milestone = await finishMilestone(db, {
    projectId: id,
    milestoneId: mid,
    environment: env.environment,
  });
  sendJson(res, 200, {}, { milestone });
});
