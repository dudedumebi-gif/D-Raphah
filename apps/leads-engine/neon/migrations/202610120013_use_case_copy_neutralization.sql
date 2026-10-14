-- Persisted use-case rows keep the copy they were generated with:
-- the GET route returns stored rows and only generates when none
-- exist, so the industry-neutral catalog rewrite (PR #52) alone
-- would leave pre-existing rows — patient_recall key included —
-- displaying, approving, and shipping with clinic wording.
-- Rewrite the exact legacy catalog phrases wherever they were
-- persisted. replace() is a no-op where a phrase is absent, so
-- LLM-drafted rows (evidence-grounded, differently worded) are
-- untouched; only deterministic-catalog text changes.
update public.opportunity_use_cases
set use_case_key = 'reactivation'
where use_case_key = 'patient_recall';

update public.opportunity_use_cases
set title = replace(title,
      'Digital patient intake', 'Digital intake forms'),
    statement = replace(replace(replace(replace(replace(replace(statement,
      'Patients can book, reschedule, and cancel appointments online without phoning the practice.',
      'Customers can book, reschedule, and cancel appointments online without phoning the business.'),
      'New-patient intake, health-history, and consent forms are completed online before the visit instead of on paper or by emailed PDF.',
      'Intake, information, and consent forms are completed online before the appointment instead of on paper or by emailed PDF.'),
      'Patients who are due or overdue for hygiene, follow-up, or treatment are recalled automatically until they rebook.',
      'Customers who are due or overdue for a follow-up or recurring service are contacted automatically until they rebook.'),
      'After a completed visit, patients are automatically invited to leave a public review or refer a friend.',
      'After a completed appointment, customers are automatically invited to leave a public review or refer a friend.'),
      'Front-desk staff time shifts from repetitive calls to patient care and follow-up',
      'Front-desk staff time shifts from repetitive calls to customer care and follow-up'),
      'Submitted information reaches the patient record without manual re-keying',
      'Submitted information reaches the customer record without manual re-keying'),
    acceptance_criteria = replace(replace(replace(replace(replace(acceptance_criteria::text,
      'A patient can complete a booking online in a few minutes, at any hour',
      'A customer can complete a booking online in a few minutes, at any hour'),
      'The patient receives an immediate confirmation with visit details',
      'The customer receives an immediate confirmation with the booking details'),
      'Staff can see which patients have completed intake before the appointment',
      'Staff can see which customers have completed intake before the appointment'),
      'Inbound documents attach to the patient record without printing or scanning',
      'Inbound documents attach to the customer record without printing or scanning'),
      'Due/overdue patients are identified automatically from the schedule history',
      'Due or overdue customers are identified automatically from the booking history'),
      'Recall messages go out on a set cadence and stop when the patient books',
      'Follow-up messages go out on a set cadence and stop when the customer books')::jsonb,
    success_metric = replace(success_metric,
      'Overdue patients reactivated per recall cycle',
      'Overdue customers reactivated per cycle'),
    success_target = replace(replace(success_target,
      'At least 80% of new patients complete intake online before their visit',
      'At least 80% of new customers complete intake online before their appointment'),
      'At least 15% of overdue patients rebooked in the first cycle',
      'At least 15% of overdue customers rebooked in the first cycle');

insert into public.schema_versions(service, version)
values ('lead-engine', '3.3.17')
on conflict (service) do update
set version = excluded.version, applied_at = now();
