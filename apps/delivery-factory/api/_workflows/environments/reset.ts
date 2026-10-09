import { defineRoute } from "../../_lib/route.js";
import { sendJson } from "../../_lib/http.js";

/**
 * POST /api/workflows/environments/:scope/reset — reset an environment.
 *
 * Only the demo environment can be reset: it clears demo workflow runs,
 * demo delivery projects, and demo handoff inbox entries so the demo
 * starts clean. Demo workflow definitions are fixtures and are kept.
 * Production is refused outright — there is no production reset.
 */
export default defineRoute(["POST"], async (req, res, { db }) => {
  const scope = req.query?.environmentScope;
  if (scope !== "demo") {
    sendJson(
      res,
      400,
      {},
      { error: "Only the demo environment can be reset" },
    );
    return;
  }
  const summary = await db.resetDemoEnvironment();
  sendJson(res, 200, {}, { reset: true, environment: "demo", ...summary });
});
