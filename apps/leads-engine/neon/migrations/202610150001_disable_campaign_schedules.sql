-- LE v4 (simplification wave): campaign schedule fields retired.
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

insert into public.schema_versions(service, version)
values ('lead-engine', '3.3.19')
on conflict (service) do update
set version = excluded.version, applied_at = now();
