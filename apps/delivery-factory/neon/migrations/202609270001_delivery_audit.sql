-- Immutable audit stream for every Delivery Factory business-state mutation.

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id text,
  action text not null,
  resource_type text not null,
  resource_id text,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now()
);
create index if not exists delivery_audit_created_idx
  on public.audit_events(created_at desc);
create index if not exists delivery_audit_resource_idx
  on public.audit_events(resource_type,resource_id,created_at desc);
alter table public.audit_events enable row level security;
revoke insert,update,delete on public.audit_events from public;

create or replace function public.capture_delivery_audit_event()
returns trigger language plpgsql security definer set search_path=public as $$
declare
  old_row jsonb;
  new_row jsonb;
  rid text;
begin
  old_row:=case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) else null end;
  new_row:=case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) else null end;
  if tg_table_name='handoff_inbox' then
    old_row:=old_row-'package'-'signature';
    new_row:=new_row-'package'-'signature';
  end if;
  rid:=coalesce(new_row->>'id',old_row->>'id',new_row->>'project_id',old_row->>'project_id');
  insert into public.audit_events(action,resource_type,resource_id,before_state,after_state)
  values(lower(tg_table_name||'.'||tg_op),tg_table_name,rid,old_row,new_row);
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array[
    'handoff_inbox','delivery_projects','stage_history','milestones',
    'clarifications','feedback_outbox','workflows','workflow_nodes',
    'workflow_edges','workflow_runs','workflow_run_steps'
  ] loop
    if to_regclass('public.'||t) is not null then
      execute format('drop trigger if exists audit_%I on public.%I',t,t);
      execute format('create trigger audit_%I after insert or update or delete on public.%I for each row execute function public.capture_delivery_audit_event()',t,t);
    end if;
  end loop;
end $$;

insert into public.schema_versions(service,version)
values('delivery-factory','1.1.0')
on conflict(service) do update set version=excluded.version,applied_at=now();
