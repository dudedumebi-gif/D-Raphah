import { askClarification } from "../../_lib/projects.js";
import { defineRoute } from "../../_lib/route.js";
import { readJsonBody, routeParam, sendJson } from "../../_lib/http.js";

/** POST /api/projects/:id/clarifications — raise a clarification. Body: { "question", "owner"? }. */
export default defineRoute(["POST"], async (req, res, { db, env }) => {
  const id = routeParam(req, "id");
  if (!id) {
    sendJson(res, 400, {}, { error: "Project id is required" });
    return;
  }
  const body = (await readJsonBody(req)) as {
    question?: unknown;
    owner?: unknown;
  };
  const clarification = await askClarification(db, {
    projectId: id,
    question: typeof body.question === "string" ? body.question : "",
    owner: typeof body.owner === "string" ? body.owner : undefined,
    environment: env.environment,
  });
  sendJson(res, 201, {}, { clarification });
});
