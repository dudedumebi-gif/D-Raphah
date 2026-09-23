import { defineRoute } from "../_lib/route.js";
import { getDb } from "../_lib/db.js";
import { readJsonBody, routeParam, sendJson } from "../_lib/http.js";
import {
  archiveWorkflow,
  deleteWorkflow,
  getWorkflow,
  publishWorkflow,
  updateWorkflow,
} from "../_lib/workflows.js";

/**
 * /api/workflows/:id
 *   GET    — full workflow with nodes/edges
 *   PUT    — replace graph, or {action:"publish"|"archive"}
 *   DELETE — delete
 */
export default defineRoute(
  ["GET", "PUT", "DELETE"],
  async (req, res) => { const db = getDb();
    const id = routeParam(req, "id");
    if (!id || id === "runs" || id === "catalog") {
      sendJson(res, 404, {}, { error: "Not found" });
      return;
    }
    if (req.method === "GET") {
      const wf = await getWorkflow(db, id);
      if (!wf) {
        sendJson(res, 404, {}, { error: "Workflow not found" });
        return;
      }
      sendJson(res, 200, {}, { workflow: wf });
      return;
    }
    if (req.method === "DELETE") {
      const ok = await deleteWorkflow(db, id);
      sendJson(
        res,
        ok ? 200 : 404,
        {},
        ok ? { deleted: true } : { error: "Workflow not found" },
      );
      return;
    }
    // PUT
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    if (body?.action === "publish") {
      const wf = await publishWorkflow(db, id);
      if (!wf) {
        sendJson(res, 404, {}, { error: "Workflow not found" });
        return;
      }
      sendJson(res, 200, {}, { workflow: wf });
      return;
    }
    if (body?.action === "archive") {
      const wf = await archiveWorkflow(db, id);
      if (!wf) {
        sendJson(res, 404, {}, { error: "Workflow not found" });
        return;
      }
      sendJson(res, 200, {}, { workflow: wf });
      return;
    }
    if (!body || typeof body.name !== "string") {
      sendJson(res, 400, {}, { error: "name is required" });
      return;
    }
    const wf = await updateWorkflow(db, id, {
      name: body.name,
      description: typeof body.description === "string" ? body.description : undefined,
      trigger_type: body.trigger_type as "manual",
      trigger_config: (body.trigger_config ?? {}) as Record<string, unknown>,
      nodes: (body.nodes ?? []) as [],
      edges: (body.edges ?? []) as [],
    });
    if (!wf) {
      sendJson(res, 404, {}, { error: "Workflow not found" });
      return;
    }
    sendJson(res, 200, {}, { workflow: wf });
  },
);
