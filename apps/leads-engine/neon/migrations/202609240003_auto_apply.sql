-- Per-campaign opt-in for automated criteria adjustment (lead-vision gap 3).
--
-- Storage model: scrape_campaigns keeps operational toggles as plain boolean
-- columns alongside the criteria jsonb (cf. schedule_enabled), so the
-- auto-apply flag follows the same pattern and does NOT live inside the
-- criteria jsonb — CriteriaSchema validates that column and strips unknown
-- keys. Default OFF: suggestions remain display-only until a human opts in.
--
-- RLS/policies: the column inherits scrape_campaigns' member_select /
-- operator_write policies; no new policy needed. Triggers: the existing
-- audit_scrape_campaigns (capture_audit_event) and campaigns_updated
-- (set_updated_at) triggers fire on updates without changes.

alter table public.scrape_campaigns
  add column auto_apply_criteria boolean not null default false;

-- The production migration grants authenticated a column-scoped UPDATE on
-- scrape_campaigns; column grants are cumulative, so the new column must be
-- added explicitly or the API's user-scoped client cannot toggle the flag.
grant update(auto_apply_criteria) on public.scrape_campaigns to authenticated;

-- Narrow security-definer RPC so the API can write audit entries for events
-- that are not table writes (lead exports are reads) and for decision events
-- that must name the human validator explicitly. Direct audit_events inserts
-- are revoked for authenticated by design; actor_id is the calling human
-- (auth.user_id()) — the required humanValidatorId for applied model
-- suggestions — and workspace membership is enforced inside the function.
create or replace function public.log_workspace_event(
  p_workspace_id uuid,
  p_action text,
  p_resource_type text,
  p_resource_id text,
  p_reason text,
  p_before_state jsonb default null,
  p_after_state jsonb default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'Not a workspace member';
  end if;
  insert into public.audit_events(
    workspace_id, actor_id, action, resource_type, resource_id,
    outcome, reason, before_state, after_state
  ) values (
    p_workspace_id, auth.user_id(), p_action, p_resource_type,
    p_resource_id, 'success', p_reason, p_before_state, p_after_state
  ) returning id into v_id;
  return v_id;
end $$;

revoke execute on function public.log_workspace_event(uuid,text,text,text,text,jsonb,jsonb)
  from public, anonymous;
grant execute on function public.log_workspace_event(uuid,text,text,text,text,jsonb,jsonb)
  to authenticated;
