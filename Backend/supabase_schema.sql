-- Schema for HackEurope2026 Backend MVP (fixed task catalog)
-- Apply this in Supabase SQL Editor.

create extension if not exists "pgcrypto";

-- Updated-at trigger helper
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -------------------------
-- patients
-- -------------------------
create table if not exists public.patients (
  id uuid primary key default gen_random_uuid(),
  patient_id int not null unique,
  first_name text not null,
  last_name text not null,
  description text not null,
  time_preferences text,
  priority_final int not null default 3,
  priority_suggested int,
  model_reason text,
  confidence double precision,
  override_reason text,
  admitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.patients
  add column if not exists time_preferences text;
alter table public.patients
  add column if not exists priority_final int;
alter table public.patients
  add column if not exists priority_suggested int;
alter table public.patients
  add column if not exists model_reason text;
alter table public.patients
  add column if not exists confidence double precision;
alter table public.patients
  add column if not exists override_reason text;

alter table public.patients
  drop constraint if exists chk_patients_priority_final;
alter table public.patients
  add constraint chk_patients_priority_final
  check (priority_final between 1 and 5);

alter table public.patients
  drop constraint if exists chk_patients_priority_suggested;
alter table public.patients
  add constraint chk_patients_priority_suggested
  check (priority_suggested is null or (priority_suggested between 1 and 5));

alter table public.patients
  drop constraint if exists chk_patients_confidence;
alter table public.patients
  add constraint chk_patients_confidence
  check (confidence is null or (confidence between 0 and 1));

drop trigger if exists trg_patients_updated_at on public.patients;
create trigger trg_patients_updated_at
before update on public.patients
for each row
execute function public.set_updated_at();

create index if not exists idx_patients_patient_id
on public.patients(patient_id);

-- -------------------------
-- patient_priority_feedback (audit log)
-- -------------------------
create table if not exists public.patient_priority_feedback (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  doctor_id text,
  suggested_priority int,
  final_priority int not null,
  model_reason text,
  confidence double precision,
  override_reason text,
  context jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_patient_priority_feedback_patient_id
on public.patient_priority_feedback(patient_id);

-- -------------------------
-- task_definitions (catalog)
-- -------------------------
create table if not exists public.task_definitions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_task_definitions_updated_at on public.task_definitions;
create trigger trg_task_definitions_updated_at
before update on public.task_definitions
for each row
execute function public.set_updated_at();

create unique index if not exists uq_task_definitions_name_ci
on public.task_definitions (lower(name));

-- -------------------------
-- patient_tasks (tasks assigned to a patient)
-- -------------------------
create table if not exists public.patient_tasks (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  task_definition_id uuid not null references public.task_definitions(id),
  status text not null default 'pending' check (status in ('pending', 'done', 'cancelled')),
  due_at timestamptz,
  llm_priority int check (llm_priority between 1 and 5),
  llm_confidence double precision check (llm_confidence between 0 and 1),
  llm_reason text,
  llm_context_hash text,
  llm_scored_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_patient_tasks_patient_task unique (patient_id, task_definition_id)
);

alter table public.patient_tasks
  add column if not exists llm_priority int;
alter table public.patient_tasks
  add column if not exists llm_confidence double precision;
alter table public.patient_tasks
  add column if not exists llm_reason text;
alter table public.patient_tasks
  add column if not exists llm_context_hash text;
alter table public.patient_tasks
  add column if not exists llm_scored_at timestamptz;

alter table public.patient_tasks
  drop constraint if exists chk_patient_tasks_llm_priority;
alter table public.patient_tasks
  add constraint chk_patient_tasks_llm_priority
  check (llm_priority is null or (llm_priority between 1 and 5));

alter table public.patient_tasks
  drop constraint if exists chk_patient_tasks_llm_confidence;
alter table public.patient_tasks
  add constraint chk_patient_tasks_llm_confidence
  check (llm_confidence is null or (llm_confidence between 0 and 1));

drop trigger if exists trg_patient_tasks_updated_at on public.patient_tasks;
create trigger trg_patient_tasks_updated_at
before update on public.patient_tasks
for each row
execute function public.set_updated_at();

create index if not exists idx_patient_tasks_patient_id
on public.patient_tasks(patient_id);

create index if not exists idx_patient_tasks_task_definition_id
on public.patient_tasks(task_definition_id);

create index if not exists idx_patient_tasks_status
on public.patient_tasks(status);

create index if not exists idx_patient_tasks_due_at
on public.patient_tasks(due_at);

-- -------------------------
-- schedule_items (calendar)
-- -------------------------
create table if not exists public.schedule_items (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  task_definition_id uuid references public.task_definitions(id) on delete set null,
  source_patient_task_id uuid references public.patient_tasks(id) on delete set null,
  task_name text not null,
  scheduled_for timestamptz not null,
  priority int not null check (priority between 1 and 5),
  score double precision not null check (score >= 0),
  created_at timestamptz not null default now()
);

-- Force scheduled_for aligned to exact hour (UTC-safe since timestamptz stores absolute time)
alter table public.schedule_items
  drop constraint if exists chk_schedule_items_hour_boundary;

alter table public.schedule_items
  add constraint chk_schedule_items_hour_boundary
  check ((extract(epoch from scheduled_for)::bigint % 3600) = 0);

create index if not exists idx_schedule_items_patient_id
on public.schedule_items(patient_id);

create index if not exists idx_schedule_items_scheduled_for
on public.schedule_items(scheduled_for);

create index if not exists idx_schedule_items_task_definition_id
on public.schedule_items(task_definition_id);

drop index if exists public.idx_schedule_items_source_patient_task_id;
create unique index if not exists uq_schedule_items_source_patient_task_id
on public.schedule_items(source_patient_task_id)
where source_patient_task_id is not null;

-- Uniqueness constraints (NO date_trunc to avoid IMMUTABLE issue)
drop index if exists public.uq_schedule_items_patient_hour;
create unique index uq_schedule_items_patient_hour
on public.schedule_items (patient_id, scheduled_for);

drop index if exists public.uq_schedule_items_task_hour;
create unique index uq_schedule_items_task_hour
on public.schedule_items (task_definition_id, scheduled_for)
where task_definition_id is not null;

-- Minimal RLS recommendations for MVP:
-- alter table public.patients enable row level security;
-- alter table public.task_definitions enable row level security;
-- alter table public.patient_tasks enable row level security;
-- alter table public.schedule_items enable row level security;
-- Start with service-role only from backend, then add policies for authenticated users.
