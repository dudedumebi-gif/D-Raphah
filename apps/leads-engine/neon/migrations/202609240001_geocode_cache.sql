-- Nominatim geocode cache for address -> coordinate enrichment (lead-vision
-- gap 5). The collector extracts a street address from the homepage text and
-- resolves it via Nominatim; the normalized address is the primary key so a
-- repeated scrape of the same business never re-hits the external API.
--
-- Cache entries are non-personal business addresses resolved at scrape time.
-- The worker reads/writes through the service role only.

create table public.geocode_cache (
  -- normalizeAddress() output: lowercased, whitespace-collapsed,
  -- punctuation-stripped form of the extracted address.
  normalized_address text primary key,
  raw_query text not null,
  latitude double precision not null check (latitude >= -90 and latitude <= 90),
  longitude double precision not null check (longitude >= -180 and longitude <= 180),
  resolved_at timestamptz not null default now(),
  source text not null default 'nominatim'
);
create index geocode_cache_resolved_at_idx
  on public.geocode_cache (resolved_at desc);

alter table public.geocode_cache enable row level security;
-- No permissive policies: only the service role reads/writes. The collector
-- performs its own cache lookup through the service client before calling
-- Nominatim (at most 1 request/second, valid User-Agent).
