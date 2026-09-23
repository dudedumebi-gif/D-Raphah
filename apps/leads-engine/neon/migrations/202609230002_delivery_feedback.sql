-- Delivery feedback receiver (machine-to-machine).
--
-- The Delivery Factory reports delivery lifecycle events back to the Lead
-- Engine over HTTPS using the versioned DeliveryFeedbackEvent/v1 contract.
-- Authentication is Ed25519: the factory signs a transport envelope
-- { event, nonce, issuedAt } with its private key; the Lead Engine verifies
-- with DELIVERY_FACTORY_PUBLIC_KEY_PEM. This keeps the two products'
-- credentials fully separate: the only shared material is the factory's
-- public key, distributed out of band.
--
-- Human sales feedback stays in lead_feedback; machine delivery telemetry
-- lands here so the two semantics never mix.

create table public.delivery_feedback_events (
  id uuid primary key default gen_random_uuid(),
  -- Idempotency key: the contract's eventId. A retried dispatch with the
  -- same eventId is acknowledged without a second row.
  event_id uuid not null unique,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  package_id uuid not null,
  event_type text not null,
  producer text not null default 'delivery-factory',
  environment text not null,
  occurred_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index delivery_feedback_events_opportunity_idx
  on public.delivery_feedback_events(opportunity_id, occurred_at desc);
create index delivery_feedback_events_workspace_idx
  on public.delivery_feedback_events(workspace_id, occurred_at desc);

-- Replay protection for inbound feedback envelopes. Rows expire 10 minutes
-- after the dispatch attempt; stale rows are pruned opportunistically.
create table public.feedback_nonces (
  nonce text primary key,
  expires_at timestamptz not null
);

alter table public.delivery_feedback_events enable row level security;
alter table public.feedback_nonces enable row level security;
-- No permissive policies: only the service role writes. The machine route
-- performs its own Ed25519 verification before touching these tables.
