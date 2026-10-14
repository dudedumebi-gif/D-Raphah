import { getDb } from "../../_lib/db.js";
import {
  beginProjectWorkflow,
  getProjectBeginState,
} from "../../_lib/handoff-triggers.js";
import { defineRoute } from "../../_lib/route.js";
import { readJsonBody, routeParam, sendJson } from "../../_lib/http.js";

/**
 * GET  /api/projects/:id/begin — the project's stage plus the published
 * lead_handoff workflows in the project's environment that an operator
 * could start for it.
 *
 * POST /api/projects/:id/begin — begin the project's delivery workflow:
 * run a published lead_handoff workflow against the project's stored
 * handoff package (body: { "workflowId"?: "<id>" }; omit when exactly
 * one is published). Draft-first, exactly like the intake trigger, and
 * a project still at 'intake' advances to 'onboarding'.
 */
export default defineRoute(
  ["GET", "POST"],
  async (req, res, { db, env, operator }) => {
    const id = routeParam(req, "id");
    if (!id) {
      sendJson(res, 400, {}, { error: "Project id is required" });
      return;
    }
    if ((req.method ?? "GET").toUpperCase() === "GET") {
      const state = await getProjectBeginState(db, getDb(), id);
      sendJson(res, 200, {}, state);
      return;
    }
    const body = ((await readJsonBody(req)) ?? {}) as {
      workflowId?: unknown;
    };
    const result = await beginProjectWorkflow(db, getDb(), {
      projectId: id,
      workflowId:
        typeof body.workflowId === "string" && body.workflowId
          ? body.workflowId
          : undefined,
      changedBy: operator.email,
      environment: env.environment,
    });
    sendJson(res, 200, {}, result);
  },
);
