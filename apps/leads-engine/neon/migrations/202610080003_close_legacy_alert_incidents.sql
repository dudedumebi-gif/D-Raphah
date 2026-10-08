-- Correct schema 3.3.3 installations where append-only alert history received
-- the new default open status. Only rows that predate the 3.3.3 cutover are
-- closed. Incidents created by the stateful evaluator after cutover remain.

with cutover as (
  select applied_at
  from public.schema_versions
  where service = 'lead-engine'
    and version = '3.3.3'
), closed as (
  update public.alert_log al
  set status = 'resolved',
      resolved_at = coalesce(al.resolved_at, al.last_observed_at, al.created_at),
      last_transition = 'resolved'
  from cutover c
  where al.status = 'open'
    and (
      al.created_at < c.applied_at
      or (
        al.alert_type = 'dead_letter'
        and exists (
          select 1
          from public.scrape_jobs sj
          where sj.id::text = al.resource_id
            and coalesce(sj.completed_at, sj.updated_at, sj.created_at) < c.applied_at
        )
      )
    )
  returning al.workspace_id, al.alert_type
)
insert into public.audit_events(
  workspace_id, actor_id, action, resource_type, resource_id,
  outcome, reason, after_state
)
select workspace_id, null, 'alert.legacy_history.corrected', 'alert_log',
  workspace_id::text, 'success',
  'Closed historical append-only alerts and pre-cutover dead letters',
  jsonb_build_object(
    'closedCount', count(*),
    'alertTypes', jsonb_agg(distinct alert_type)
  )
from closed
group by workspace_id;

insert into public.schema_versions(service, version)
values ('lead-engine', '3.3.4')
on conflict (service) do update
set version = excluded.version, applied_at = now();
