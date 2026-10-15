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
      if (ok) {
        sendJson(res, 200, {}, { deleted: true });
        return;
      }
      // deleteWorkflow is status-guarded: distinguish "not there"
      // from "there but published" so the operator gets the real
      // reason instead of a misleading 404.
      const existing = await getWorkflow(db, id);
      if (existing) {
        sendJson(
          res,
          409,
          {},
          {
            error:
              "Only draft or archived workflows can be deleted — archive it first.",
          },
        );
        return;
      }
      sendJson(res, 404, {}, { error: "Workflow not found" });
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
      // Omitted trigger_config means UNCHANGED, never "clear it":
      // the builder's save payload does not carry the field, and
      // generated skeletons keep their project/requirement linkage
      // in it — defaulting to {} here silently unlinked every
      // skeleton an operator reviewed and saved (Codex on PR #60).
      // An explicit object (including {}) still replaces it.
      trigger_config:
        typeof body.trigger_config === "object" &&
        body.trigger_config !== null
          ? (body.trigger_config as Record<string, unknown>)
          : undefined,
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
