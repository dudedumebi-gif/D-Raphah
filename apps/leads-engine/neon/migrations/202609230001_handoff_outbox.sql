-- Lead Engine handoff outbox: durable, idempotent queue of signed
-- LeadEngineHandoffPackage payloads awaiting dispatch to the Delivery Factory.
-- Emission is human-approved via POST /api/v1/handoffs; the worker drains
-- pending rows and POSTs them to DELIVERY_INTAKE_URL with exponential backoff.
-- Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/leads-engine/neon/migrations/202609230001_handoff_outbox.sql

create table public.handoff_outbox (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  idempotency_key text not null unique,
  package jsonb not null,
  manifest_checksum text not null,
  signature text not null,
  status text not null default 'pending' check (status in ('pending','dispatching','sent','failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  dispatched_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.handoff_outbox enable row level security;

-- Read-only for workspace members; writes go exclusively through the
-- enqueue_handoff_outbox RPC below, matching the revoked-mutation posture of
-- the other sensitive tables (direct authenticated mutations stay denied).
create policy handoff_outbox_member_select on public.handoff_outbox
  for select using (public.is_workspace_member(workspace_id));

create or replace function public.enqueue_handoff_outbox(
  p_workspace_id uuid,
  p_idempotency_key text,
  p_package jsonb,
  p_checksum text,
  p_signature text
)
returns public.handoff_outbox language plpgsql security definer set search_path = public as $$
declare result public.handoff_outbox;
begin
  if not public.has_workspace_role(p_workspace_id, array['owner','administrator','analyst']::public.workspace_role[]) then
    raise exception 'permission denied' using errcode='42501';
  end if;
  if p_checksum !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid manifest checksum';
  end if;
  insert into public.handoff_outbox(workspace_id, idempotency_key, package, manifest_checksum, signature)
    values(p_workspace_id, p_idempotency_key, p_package, p_checksum, p_signature)
    on conflict(idempotency_key) do nothing;
  select * into result from public.handoff_outbox
    where idempotency_key = p_idempotency_key and workspace_id = p_workspace_id;
  if result.id is null then
    raise exception 'idempotency key already used for a different request';
  end if;
  return result;
end $$;
revoke execute on function public.enqueue_handoff_outbox(uuid,text,jsonb,text,text) from public,anonymous;
grant execute on function public.enqueue_handoff_outbox(uuid,text,jsonb,text,text) to authenticated;

create trigger handoff_outbox_updated before update on public.handoff_outbox
  for each row execute function public.set_updated_at();

grant select on public.handoff_outbox to authenticated;

insert into public.schema_versions(service, version) values ('lead-engine', '3.1.0')
on conflict (service) do update set version = excluded.version, applied_at = now();
