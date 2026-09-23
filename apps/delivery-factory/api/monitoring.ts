import { defineRoute } from "./_lib/route.js";
import { sendJson } from "./_lib/http.js";

/**
 * GET /api/monitoring — operator monitoring snapshot for the Delivery Factory.
 *
 * Returns recent handoff inbox activity, feedback outbox queue depth, nonce
 * replay-protection state, and QStash schedule configuration status. The
 * frontend's Monitoring view polls this alongside the Lead Engine liveness
 * and readiness endpoints.
 *
 * Read-only. No operator authentication yet (same posture as the other
 * operator routes; see api/_lib/route.ts).
 */
export default defineRoute(["GET"], async (_req, res, { db }) => {
  const snapshot = await db.getMonitoringSnapshot();
  const qstashConfigured = Boolean(process.env.QSTASH_TOKEN);
  sendJson(res, 200, {}, {
    service: "delivery-factory",
    checkedAt: new Date().toISOString(),
    recentHandoffs: snapshot.recentHandoffs,
    feedbackOutbox: snapshot.feedbackOutbox,
    activeNonces: snapshot.activeNonces,
    qstash: {
      configured: qstashConfigured,
      // The three production schedules: LE worker tick, LE canary,
      // DF feedback dispatcher. DF only observes its own dispatcher here;
      // LE schedules are visible on the Lead Engine monitoring surface.
      schedules: [
        {
          name: "delivery-factory feedback dispatcher",
          cadence: "every 5 minutes",
          route: "POST /api/internal/dispatch-feedback",
          status: qstashConfigured ? "configured" : "not_configured",
        },
      ],
    },
  });
});
