-- lead_feedback.data_mode exists since 202609290001 with default
-- 'pilot', designed to mirror the parent opportunity's mode (that
-- migration backfilled it exactly that way). But no insert path
-- ever set it, so every API-written feedback row — reviewer
-- decisions and proposal-sent outcomes alike — is stamped 'pilot'
-- regardless of the lead's real mode. The API routes now stamp
-- the opportunity's mode at insert; this migration repairs the
-- existing rows the same way 202609290001 did.
update public.lead_feedback f
set data_mode = o.data_mode
from public.opportunities o
where o.id = f.opportunity_id
  and f.data_mode <> o.data_mode;

insert into public.schema_versions(service, version)
values ('lead-engine', '3.3.16')
on conflict (service) do update
set version = excluded.version, applied_at = now();
