import { addMilestone } from "../../_lib/projects.js";
import { defineRoute } from "../../_lib/route.js";
import { readJsonBody, routeParam, sendJson } from "../../_lib/http.js";

/** POST /api/projects/:id/milestones — add a milestone. Body: { "title", "targetDate"?: "YYYY-MM-DD" }. */
export default defineRoute(["POST"], async (req, res, { db }) => {
  const id = routeParam(req, "id");
  if (!id) {
    sendJson(res, 400, {}, { error: "Project id is required" });
    return;
  }
  const body = (await readJsonBody(req)) as {
    title?: unknown;
    targetDate?: unknown;
  };
  const milestone = await addMilestone(db, {
    projectId: id,
    title: typeof body.title === "string" ? body.title : "",
    targetDate:
      typeof body.targetDate === "string" ? body.targetDate : undefined,
  });
  sendJson(res, 201, {}, { milestone });
});
