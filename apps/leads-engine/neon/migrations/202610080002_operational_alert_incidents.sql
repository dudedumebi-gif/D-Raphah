-- Stateful operational incidents with cooldown reminders and recoveries.
-- Expands the append-style alert_log introduced in 3.2 without deleting
-- existing rows or changing its workspace isolation policy.

alter table public.alert_log
  add column if not exists severity text not null default 'critical'
    check (severity in ('critical','warning','info')),
  add column if not exists status text not null default 'open'
    check (status in ('open','resolved')),
  add column if not exists first_observed_at timestamptz not null default now(),
  add column if not exists last_observed_at timestamptz not null default now(),
  add column if not exists last_notified_at timestamptz,
  add column if not exists resolved_at timestamptz,
  add column if not exists last_transition text not null default 'opened'
    check (last_transition in ('opened','reminder','resolved','unchanged')),
  add column if not exists occurrence_count integer not null default 1
    check (occurrence_count > 0);

-- Rows created before this migration were append-only notifications, not
-- stateful incidents. Close them before last_notified_at is backfilled so a
-- fresh migration does not present historical alerts as currently open.
update public.alert_log
set status = 'resolved',
    resolved_at = coalesce(resolved_at, created_at),
    last_transition = 'resolved'
where status = 'open'
  and last_notified_at is null;

update public.alert_log
set last_notified_at = coalesce(last_notified_at, created_at),
    first_observed_at = coalesce(first_observed_at, created_at),
    last_observed_at = coalesce(last_observed_at, created_at)
where last_notified_at is null;

create index if not exists alert_log_open_workspace_idx
  on public.alert_log(workspace_id, alert_type, last_observed_at desc)
  where status = 'open';

insert into public.schema_versions(service, version)
values ('lead-engine', '3.3.3')
on conflict (service) do update
set version = excluded.version, applied_at = now();
