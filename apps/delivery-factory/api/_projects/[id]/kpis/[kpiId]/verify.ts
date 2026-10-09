import { verifyCharterKpi } from "../../../../_lib/projects.js";
import { defineRoute } from "../../../../_lib/route.js";
import { readJsonBody, routeParam, sendJson } from "../../../../_lib/http.js";

/**
 * POST /api/projects/:id/kpis/:kpiId/verify — record a post-build KPI
 * verification. Body: { "status": "met" | "missed", "measuredValue"?,
 * "note"? }. The verifier is the authenticated operator, never a
 * client-supplied string.
 */
export default defineRoute(["POST"], async (req, res, { db, operator }) => {
  const id = routeParam(req, "id");
  const kpiId = routeParam(req, "kpiId");
  if (!id || !kpiId) {
    sendJson(res, 400, {}, { error: "Project id and KPI id are required" });
    return;
  }
  const body = (await readJsonBody(req)) as {
    status?: unknown;
    measuredValue?: unknown;
    note?: unknown;
  };
  const kpi = await verifyCharterKpi(db, {
    projectId: id,
    kpiId,
    status: typeof body.status === "string" ? body.status : "",
    measuredValue:
      typeof body.measuredValue === "string" ? body.measuredValue : undefined,
    note: typeof body.note === "string" ? body.note : undefined,
    verifiedBy: operator.email,
  });
  sendJson(res, 200, {}, { kpi });
});
