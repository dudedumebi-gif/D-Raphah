-- Delivery Factory production schema: durable intake inbox, delivery projects,
-- stage history, milestones, clarifications, feedback outbox, and replay
-- protection nonces. This database is OWNED by the Delivery Factory and is
-- never shared with the Lead Engine: the only integration surface is the
-- versioned LeadEngineHandoffPackage contract over POST /api/intake.
--
-- Security posture: RLS is enabled on every table with NO permissive
-- policies, so only the service role (DELIVERY_DATABASE_URL) can read or
-- write. End-user/operator authentication is out of scope for this phase and
-- must be added before any browser-facing session touches these tables.
--
-- Apply with:
--   psql "$DELIVERY_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f apps/delivery-factory/neon/migrations/202609230002_delivery_factory_production.sql

create table public.schema_versions (
  service text primary key,
  version text not null,
  applied_at timestamptz not null default now()
);

insert into public.schema_versions(service, version)
values ('delivery-factory', '1.0.0')
on conflict (service) do update set version = excluded.version, applied_at = now();

-- Every accepted (or replayed) handoff package, keyed by the sender's
-- idempotency key. The manifest checksum and Ed25519 signature are stored
-- alongside the package so acceptance can be re-audited later.
create table public.handoff_inbox (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  package jsonb not null,
  manifest_checksum text not null check (manifest_checksum ~ '^[a-f0-9]{64}$'),
  signature text not null,
  status text not null default 'received'
    check (status in ('received', 'processed', 'failed')),
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

-- Delivery projects created from accepted handoffs. One project per inbox
-- row; the pipeline order is intake -> onboarding -> blueprint_drafting ->
-- implementation -> testing -> handover -> completed.
create table public.delivery_projects (
  id uuid primary key default gen_random_uuid(),
  inbox_id uuid not null unique references public.handoff_inbox(id) on delete cascade,
  package_id uuid not null,
  package_version integer not null,
  opportunity_id uuid not null,
  organization_name text not null,
  name text,
  status text not null default 'active'
    check (status in ('active', 'on_hold', 'completed', 'cancelled')),
  current_stage text not null default 'intake'
    check (current_stage in ('intake', 'onboarding', 'blueprint_drafting',
                            'implementation', 'testing', 'handover', 'completed')),
  baseline_version integer not null,
  requirements_count integer not null default 0,
  features_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.stage_history (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.delivery_projects(id) on delete cascade,
  from_stage text not null,
  to_stage text not null,
  changed_by text,
  changed_at timestamptz not null default now()
);
create index stage_history_project_idx on public.stage_history(project_id, changed_at);

create table public.milestones (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.delivery_projects(id) on delete cascade,
  title text not null,
  target_date date,
  completed boolean not null default false,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index milestones_project_idx on public.milestones(project_id);

create table public.clarifications (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.delivery_projects(id) on delete cascade,
  question text not null,
  owner text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index clarifications_project_idx on public.clarifications(project_id);

-- Outbound DeliveryFeedbackEvent v1 payloads awaiting dispatch to the Lead
-- Engine. A future worker drains pending rows and POSTs them to the Lead
-- Engine feedback endpoint with the same signing/replay discipline as intake.
create table public.feedback_outbox (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.delivery_projects(id) on delete cascade,
  event jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'dispatching', 'sent', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index feedback_outbox_due_idx
  on public.feedback_outbox(status, next_attempt_at);

-- Replay protection for x-raphah-nonce. Rows expire 10 minutes after the
-- intake attempt; stale rows are pruned opportunistically on each intake.
create table public.used_nonces (
  nonce text primary key,
  expires_at timestamptz not null
);

alter table public.schema_versions enable row level security;
alter table public.handoff_inbox enable row level security;
alter table public.delivery_projects enable row level security;
alter table public.stage_history enable row level security;
alter table public.milestones enable row level security;
alter table public.clarifications enable row level security;
alter table public.feedback_outbox enable row level security;
alter table public.used_nonces enable row level security;

-- Intentionally no GRANTs and no permissive policies: with RLS enabled and
-- no policies, every non-service role is denied. All access in this phase
-- goes through the service-role connection string (DELIVERY_DATABASE_URL)
-- used by the Vercel functions. End-user auth is a later phase.
