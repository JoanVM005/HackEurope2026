-- Test seed data for HackEurope2026 backend
-- Creates 5 patients (different severity), 5 task definitions,
-- and assigns 2-3 tasks per patient.

begin;

-- 1) Patients (severity represented in description + different admitted_at)
insert into patients (patient_id, first_name, last_name, description, time_preferences, admitted_at)
values
  ('P-001', 'Elena', 'Ruiz', 'Severity: critical. Severe chest pain and hypotension.', 'pref_time=morning; avoid=late_evening', now() - interval '6 hours'),
  ('P-002', 'Martin', 'Lopez', 'Severity: high. Persistent dyspnea and fever.', 'pref_time=afternoon; avoid=08:00-10:00', now() - interval '4 hours'),
  ('P-003', 'Sofia', 'Navarro', 'Severity: medium. Post-op monitoring required.', 'pref_time=midday', now() - interval '3 hours'),
  ('P-004', 'David', 'Moreno', 'Severity: low-medium. Mild abdominal pain under observation.', 'pref_time=morning; avoid=13:00-15:00', now() - interval '2 hours'),
  ('P-005', 'Paula', 'Santos', 'Severity: low. Stable, awaiting routine checks.', 'pref_time=flexible', now() - interval '1 hour')
on conflict (patient_id) do update
set
  first_name = excluded.first_name,
  last_name = excluded.last_name,
  description = excluded.description,
  time_preferences = excluded.time_preferences,
  admitted_at = excluded.admitted_at,
  updated_at = now();

-- 2) Task catalog
insert into task_definitions (name)
values
  ('Blood test'),
  ('ECG'),
  ('X-Ray'),
  ('Medication administration'),
  ('Nursing reassessment')
on conflict do nothing;

-- 3) Patient-task assignments (2-3 tasks per patient)
with p as (
  select id, patient_id from patients where patient_id in ('P-001','P-002','P-003','P-004','P-005')
),
t as (
  select id, name from task_definitions
  where name in (
    'Blood test',
    'ECG',
    'X-Ray',
    'Medication administration',
    'Nursing reassessment'
  )
)
insert into patient_tasks (patient_id, task_definition_id, status, due_at)
select
  p.id,
  t.id,
  assignment.status,
  now() + assignment.due_in
from (
  values
    ('P-001', 'ECG', 'pending', interval '30 minutes'),
    ('P-001', 'Blood test', 'pending', interval '1 hour'),
    ('P-001', 'Medication administration', 'pending', interval '2 hours'),

    ('P-002', 'X-Ray', 'pending', interval '1 hour'),
    ('P-002', 'Nursing reassessment', 'pending', interval '2 hours'),

    ('P-003', 'Blood test', 'pending', interval '45 minutes'),
    ('P-003', 'Medication administration', 'pending', interval '90 minutes'),
    ('P-003', 'Nursing reassessment', 'pending', interval '3 hours'),

    ('P-004', 'X-Ray', 'pending', interval '2 hours'),
    ('P-004', 'Nursing reassessment', 'pending', interval '4 hours'),

    ('P-005', 'Blood test', 'pending', interval '2 hours'),
    ('P-005', 'ECG', 'pending', interval '3 hours'),
    ('P-005', 'Medication administration', 'pending', interval '5 hours')
) as assignment(patient_external_id, task_name, status, due_in)
join p on p.patient_id = assignment.patient_external_id
join t on t.name = assignment.task_name
on conflict (patient_id, task_definition_id) do update
set
  status = excluded.status,
  due_at = excluded.due_at,
  updated_at = now();

commit;
