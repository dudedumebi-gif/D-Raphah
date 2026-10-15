-- Use-case workflow skeletons: database-backed uniqueness for the
-- generator's one-skeleton-per-(project, requirement) promise.
--
-- Skeletons link to their project and requirement through
-- trigger_config ({projectId, packageId, requirementId,
-- requirementCode}). The key is the requirement's unique id, not
-- its code: codes are display slugs the Lead Engine truncates, so
-- two distinct use cases can share one. A select-then-insert check
-- races when two generator calls overlap (concurrent intake
-- accepts, or an operator POST racing intake): both lookups miss
-- and both insert. This partial unique index over the two jsonb
-- keys makes the second insert fail atomically; the generator
-- catches the violation and adopts the winner's row. Workflows
-- without both keys (every hand-built workflow) are untouched.
--
-- Schema 1.5.0

create unique index if not exists uq_workflows_use_case_skeleton
  on public.workflows (
    (trigger_config->>'projectId'),
    (trigger_config->>'requirementId')
  )
  where trigger_config ? 'projectId'
    and trigger_config ? 'requirementId';

insert into public.schema_versions(service, version)
values ('delivery-factory', '1.5.0')
on conflict (service) do update set version = excluded.version, applied_at = now();
