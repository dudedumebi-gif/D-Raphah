import { getProjectCharter } from "../../_lib/projects.js";
import { defineRoute } from "../../_lib/route.js";
import { routeParam, sendJson } from "../../_lib/http.js";

/**
 * GET /api/projects/:id/charter — the project charter: the handoff package
 * presented as the project's founding document (problem statement, current
 * state, requirement baseline with acceptance criteria, feature outcomes,
 * commercial scope, constraints, risks, open items, provenance) plus the
 * KPIs restated from the package's success measures and their post-build
 * verification verdicts.
 */
export default defineRoute(["GET"], async (req, res, { db }) => {
  const id = routeParam(req, "id");
  if (!id) {
    sendJson(res, 400, {}, { error: "Project id is required" });
    return;
  }
  const charter = await getProjectCharter(db, id);
  sendJson(res, 200, {}, { charter });
});
