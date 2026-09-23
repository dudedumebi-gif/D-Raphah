import { defineRoute } from "../../_lib/route.js";
import { routeParam, sendJson } from "../../_lib/http.js";

/**
 * GET /api/projects/:id/events — pollable feed of the project's outbound
 * feedback events (handoff accepted, clarifications, milestones, closure).
 * Backs the operations UI's live delivery feed until a streaming transport
 * lands.
 */
export default defineRoute(["GET"], async (req, res, { db }) => {
  const id = routeParam(req, "id");
  if (!id) {
    sendJson(res, 400, {}, { error: "Project id is required" });
    return;
  }
  const project = await db.getProject(id);
  if (!project) {
    sendJson(res, 404, {}, { error: "Project not found" });
    return;
  }
  const events = await db.listProjectEvents(id);
  sendJson(res, 200, {}, { events });
});
