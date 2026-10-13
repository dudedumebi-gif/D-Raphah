-- Job Bank market view: role-level rollups (2026-10-12).
--
-- The city snapshot (202610120004) powers scoring. This companion
-- table powers the operator-facing market view: postings per
-- (posting month, city, role title) for clinic front-desk roles, so
-- the UI can show top roles and month-over-month demand growth
-- without re-reading the 47 MB source files. Written by the same
-- gated, fail-soft worker sync that maintains the city snapshot.
-- Internal reference data: RLS on, no Data API grants (read via the
-- admin SQL client in the /api/v1/job-bank-market route).
--
-- Schema 3.3.9

create table if not exists public.job_bank_role_rollups (
  period_month date not null,
  city text not null,
  province text not null,
  role_title text not null,
  postings integer not null,
  synced_at timestamptz not null default now(),
  primary key (period_month, city, province, role_title)
);

create index if not exists job_bank_rollups_period_idx
  on public.job_bank_role_rollups(period_month desc);

alter table public.job_bank_role_rollups enable row level security;
revoke all on public.job_bank_role_rollups from public, anonymous, authenticated;
