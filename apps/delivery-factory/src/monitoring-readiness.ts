/* ── Per-product readiness ─────────────────────────────────────────────
 * The Monitoring status strip shows one readiness indicator per
 * product, and each indicator derives ONLY from that product's own
 * readiness probe. The strip previously folded both products' probes
 * into a single value, so a Lead Engine failure marked Delivery
 * Factory degraded even when DF /api/ready was healthy (Codex P2 on
 * PR #63). This module is the pure shaping behind the strip; the
 * component lives in monitoring.tsx.
 */

export type HealthState = "up" | "down" | "degraded" | "loading" | "unknown";

/** The slice of a readiness HTTP response the shaping needs. The
 * monitoring fetch helper's result is structurally compatible. */
export interface ReadinessProbe {
  ok: boolean;
  status: number;
  data: unknown;
}

export interface ProductReadiness {
  state: HealthState;
  detail: string;
}

/**
 * Shape ONE product's readiness probe into its strip indicator. A null
 * probe means the request itself failed (unreachable). Checks pass
 * when flagged `ok: true` or with status "ok"/"pass" — the readiness
 * payloads of both products use one of those shapes.
 */
export function readinessFromProbe(
  probe: ReadinessProbe | null,
): ProductReadiness {
  if (!probe) return { state: "down", detail: "Unreachable" };
  const data = (probe.data ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(data.checks) ? data.checks : [];
  const checks = rows.map((c) => {
    const r = c as Record<string, unknown>;
    return {
      name: String(r.name ?? r.check ?? "check"),
      ok: r.ok === true || r.status === "ok" || r.status === "pass",
    };
  });
  if (probe.ok && checks.every((check) => check.ok)) {
    return { state: "up", detail: "Ready — all configuration checks pass" };
  }
  const missing = checks.filter((c) => !c.ok).map((c) => c.name);
  return {
    state: "degraded",
    detail:
      missing.length > 0
        ? `Not ready: ${missing.join(", ")}`
        : `Readiness HTTP ${probe.status}`,
  };
}
