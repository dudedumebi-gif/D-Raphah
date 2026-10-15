import { getDb } from "../../_lib/db.js";
import { ensureUseCaseWorkflows } from "../../_lib/use-case-workflows.js";
import { defineRoute } from "../../_lib/route.js";
import { routeParam, sendJson } from "../../_lib/http.js";

/**
 * POST /api/projects/:id/workflow-skeletons — generate this project's
 * use-case workflow skeletons from its stored handoff package: one
 * draft workflow per approved requirement, in the project's own
 * environment scope. This is the manual counterpart of the intake
 * hook (which generates them automatically when a package lands) for
 * projects accepted before it existed. Idempotent — skeletons that
 * already exist are reported under `existing`, never duplicated.
 * Skeletons are drafts: creating one never publishes or runs it.
 */
export default defineRoute(["POST"], async (req, res, { db, operator }) => {
  const id = routeParam(req, "id");
  if (!id) {
    sendJson(res, 400, {}, { error: "Project id is required" });
    return;
  }
  const project = await db.getProject(id);
  if (!project)
    throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  const result = await ensureUseCaseWorkflows(getDb(), project, {
    createdBy: operator.email,
  });
  sendJson(res, 200, {}, result);
});
