-- Track suggestion lifecycle per campaign so the Criteria page doesn't
-- re-suggest immediately after the operator applies or saves criteria.
-- A new suggestion is only generated when the observed qualified count
-- changes (new scrape data) after the last suggestion interaction.
alter table public.scrape_campaigns
  add column if not exists last_suggestion_at timestamptz,
  add column if not exists last_suggestion_observed_count integer,
  add column if not exists last_suggestion_direction text;
