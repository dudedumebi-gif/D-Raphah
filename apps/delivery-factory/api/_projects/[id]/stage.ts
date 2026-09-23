import { transitionProjectStage } from "../../_lib/projects.js";
import { defineRoute } from "../../_lib/route.js";
import { readJsonBody, routeParam, sendJson } from "../../_lib/http.js";

/**
 * PATCH /api/projects/:id/stage — move the project along the pipeline.
 * Body: { "stage": "<stage>", "changedBy"?: "<actor>" }.
 * Forward exactly one step, or backward to any earlier stage; completed is
 * terminal. Every move is recorded in stage_history.
 */
export default defineRoute(["PATCH"], async (req, res, { db, env }) => {
  const id = routeParam(req, "id");
  if (!id) {
    sendJson(res, 400, {}, { error: "Project id is required" });
    return;
  }
  const body = (await readJsonBody(req)) as {
    stage?: unknown;
    changedBy?: unknown;
  };
  const project = await transitionProjectStage(db, {
    projectId: id,
    toStage: body.stage as string,
    changedBy: typeof body.changedBy === "string" ? body.changedBy : undefined,
    environment: env.environment,
  });
  sendJson(res, 200, {}, { project });
});
