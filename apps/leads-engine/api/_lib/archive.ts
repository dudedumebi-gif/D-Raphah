/**
 * Retire/restore decisions for sources and campaigns (History).
 *
 * Retirement is the auditable alternative to deletion: rows, jobs,
 * assessments, and audit history survive; the status change alone
 * stops collection, because every collection path keys off
 * status = 'active'. Restore returns the record to the exact status
 * it held before retiring, so restoring can never become an
 * approval bypass.
 */

export const RETIRED_STATUS = "retired";

/** Job states that mean collection work is still in flight. */
export const IN_FLIGHT_JOB_STATUSES = [
  "queued",
  "leased",
  "running",
  "retrying",
] as const;

/**
 * Why a source cannot retire right now, or null when it can. A
 * source with jobs in flight would strand them mid-collection (the
 * persist step refuses non-active sources), so retirement waits for
 * the queue to settle; terminal work is history and never blocks.
 */
export function sourceRetireBlocker(inFlightJobs: number): string | null {
  if (inFlightJobs > 0) {
    return (
      `Source still has ${inFlightJobs} job(s) in flight ` +
      "(queued, leased, running, or retrying). Let them finish or " +
      "dead-letter before retiring it."
    );
  }
  return null;
}

/** The status a restore should return to (never invents 'active'). */
export function restoreStatus(retiredFromStatus: string | null): string {
  return retiredFromStatus && retiredFromStatus !== RETIRED_STATUS
    ? retiredFromStatus
    : "active";
}

export function isRetired(status: string | null | undefined): boolean {
  return status === RETIRED_STATUS;
}

/** Result payload of the set_source_retired / set_campaign_retired RPCs. */
export interface RetireOutcome {
  outcome: string;
  name?: string;
  from_status?: string;
  to_status?: string;
  in_flight?: number;
}

export type RetireDecision =
  | { kind: "retired"; fromStatus: string | null }
  | { kind: "restored"; toStatus: string }
  | { kind: "error"; statusCode: number; message: string };

/**
 * Map an RPC outcome to the route's HTTP semantics. The transitions
 * themselves (guard + write) run atomically inside the SECURITY
 * DEFINER functions; this is only the translation to status codes
 * and operator-facing messages, kept pure so it is unit-testable.
 */
export function retireDecision(
  result: RetireOutcome,
  label: "Source" | "Campaign",
): RetireDecision {
  switch (result.outcome) {
    case "retired":
      return { kind: "retired", fromStatus: result.from_status ?? null };
    case "restored":
      return { kind: "restored", toStatus: result.to_status ?? "active" };
    case "not_found":
      return { kind: "error", statusCode: 404, message: `${label} not found` };
    case "already_retired":
      return {
        kind: "error",
        statusCode: 409,
        message: `${label} is already retired`,
      };
    case "not_retired":
      return {
        kind: "error",
        statusCode: 409,
        message: `${label} is not retired`,
      };
    case "blocked":
      return {
        kind: "error",
        statusCode: 409,
        message:
          sourceRetireBlocker(Number(result.in_flight ?? 0)) ??
          `${label} cannot retire yet`,
      };
    default:
      return {
        kind: "error",
        statusCode: 500,
        message: `Unexpected retire outcome: ${result.outcome}`,
      };
  }
}
