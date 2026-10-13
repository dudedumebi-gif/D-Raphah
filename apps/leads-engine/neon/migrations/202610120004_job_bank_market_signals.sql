-- Job Bank market-intent bridge (2026-10-12).
--
-- Scoring 3.0.0's intent/trigger factor reads commercial signals from
-- the clinic's own website; real clinic sites rarely publish hiring
-- evidence there (61 of the first 66 PRD-scored clinics scored
-- intent_trigger = 0). The Canada Job Bank open-data snapshot proves
-- the market demand — Toronto alone carried 71 postings for clinic
-- front-desk roles in Aug-Sep 2026 — but it withholds employer
-- identity, so the evidence is market-level and inferential.
--
-- This table holds the per-city snapshot the worker refreshes daily
-- from the monthly CKAN files: postings for clinic front-desk roles in
-- the trailing 60 days. At scoring time the worker adds ONE synthetic
-- signal for a sufficiently active market, with strength from the
-- campaign criteria (jobBankMarketStrength; 0 disables). Internal
-- reference data only: RLS on, no Data API grants (the worker reads it
-- through the SQL client, so column renames here can never trip the
-- Data API schema cache).
--
-- Schema 3.3.8

create table if not exists public.job_bank_market_signals (
  city text not null,
  province text not null,
  postings_60d integer not null,
  latest_posted date,
  synced_at timestamptz not null default now(),
  primary key (city, province)
);

create index if not exists job_bank_market_city_idx
  on public.job_bank_market_signals(lower(city));

alter table public.job_bank_market_signals enable row level security;
revoke all on public.job_bank_market_signals from public, anonymous, authenticated;
