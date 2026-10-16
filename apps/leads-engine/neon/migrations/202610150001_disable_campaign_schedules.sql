-- LE v4 (simplification wave): campaign schedule fields retired, and
-- open incidents of the retired canary/release-gate alert types closed.
--
-- The worker's enqueue_due_scrape_jobs() enqueues collection jobs for
-- every campaign with schedule_enabled = true whose next_run_at is due.
-- v4 removes the schedule controls (Criteria form + criteria PATCH
-- contract), so a persisted enabled schedule would keep collecting
-- indefinitely with no operator control short of retiring the campaign.
-- This one-time migration disables every persisted campaign schedule as
-- part of the cut. Manual queueing ("Queue scrape", "Re-queue scrape",
-- discovery runs) is unaffected, and retiring a campaign continues to
-- stop its collection entirely.
--
-- Operator-run in the LE Neon project (raphah-lead-engine), in the same
-- window as the v4 deployment. Idempotent: safe to re-run.

update public.scrape_campaigns
set schedule_enabled = false,
    next_run_at = null
where schedule_enabled
   or next_run_at is not null;

-- The same release retires the canary and release-gate alert types
-- (canary_stuck, canary_failed, canary_target_mismatch, soak_passed,
-- production_gate_passed): their reconciliation paths are gone, so any
-- rows still open would otherwise sit in the incident list forever.
-- Resolve them as part of the upgrade; the alert history is preserved.
update public.alert_log
set status = 'resolved',
    resolved_at = now(),
    last_observed_at = now(),
    last_notified_at = now(),
    last_transition = 'resolved',
    reason = 'Alert type retired in LE v4 (canary / release-gate subsystem removed); incident closed by migration 202610150001.'
where status = 'open'
  and alert_type in (
    'canary_stuck',
    'canary_failed',
    'canary_target_mismatch',
    'soak_passed',
    'production_gate_passed'
  );

insert into public.schema_versions(service, version)
values ('lead-engine', '3.3.19')
on conflict (service) do update
set version = excluded.version, applied_at = now();
