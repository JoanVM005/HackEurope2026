# API Endpoints Reference

Base URL (local): `http://127.0.0.1:8000`

All timestamps are ISO-8601 (`YYYY-MM-DDTHH:MM:SSZ`) and normalized to UTC.

## Common Error Shape
Most errors use FastAPI default:
```json
{
  "detail": "error message"
}
```

## Health

### `GET /health`
- Description: Service health check.
- Request body: none.
- Response `200`:
```json
{
  "status": "ok",
  "env": "dev"
}
```

## Patients

### `POST /patients`
- Description: Create a patient.
- Request body:
```json
{
  "patient_id": 1051,
  "first_name": "Elena",
  "last_name": "Ruiz",
  "description": "Severity: critical",
  "time_preferences": "pref_time=morning; avoid=late_evening",
  "priority_final": 4,
  "priority_suggested": 4,
  "model_reason": "Shortness of breath noted; recent admission.",
  "confidence": 0.72,
  "override_reason": null,
  "admitted_at": "2026-02-21T08:00:00Z"
}
```
- Response `201` (`PatientResponse`):
```json
{
  "id": "uuid",
  "patient_id": 1051,
  "first_name": "Elena",
  "last_name": "Ruiz",
  "description": "Severity: critical",
  "time_preferences": "pref_time=morning; avoid=late_evening",
  "priority_final": 4,
  "priority_suggested": 4,
  "model_reason": "Shortness of breath noted; recent admission.",
  "confidence": 0.72,
  "override_reason": null,
  "admitted_at": "2026-02-21T08:00:00+00:00",
  "created_at": "2026-02-21T09:00:00+00:00",
  "updated_at": "2026-02-21T09:00:00+00:00"
}
```
- Errors: `400`, `409`, `502`.

### `GET /patients`
- Description: List patients.
- Request body: none.
- Response `200`: `PatientResponse[]`.
- Errors: `502`.

### `GET /patients/{patient_id}`
- Description: Get patient by external `patient_id`.
- Path params:
  - `patient_id` (string)
- Response `200`: `PatientResponse`.
- Errors: `404`, `502`.

### `PUT /patients/{patient_id}`
- Description: Partial update by external `patient_id`.
- Path params:
  - `patient_id` (string)
- Request body (at least one field):
```json
{
  "first_name": "Elena",
  "last_name": "Ruiz",
  "description": "Updated",
  "time_preferences": "pref_time=afternoon; avoid=08:00-10:00",
  "priority_final": 5,
  "override_reason": "Doctor judgement: unstable presentation.",
  "admitted_at": "2026-02-21T08:30:00Z"
}
```
- Response `200`: `PatientResponse`.
- Errors: `400`, `404`, `502`.

### `DELETE /patients/{patient_id}`
- Description: Delete patient by external `patient_id`.
- Response `204`: empty body.
- Errors: `404`, `502`.

### `POST /patients/priority-preview`
- Description: Preview LLM priority before saving patient.
- Request body:
```json
{
  "first_name": "Elena",
  "last_name": "Ruiz",
  "description": "Severity: critical",
  "time_preferences": "prefers mornings, avoid late afternoons",
  "admitted_at": "2026-02-21T08:00:00Z",
  "task_names": ["ECG", "Blood test"]
}
```
- Response `200`:
```json
{
  "suggested_priority": 4,
  "confidence": 0.72,
  "model_reason": "Shortness of breath noted; recent admission."
}
```

## Task Definitions

### `POST /task-definitions`
- Description: Create a task definition.
- Request body:
```json
{
  "name": "Blood test"
}
```
- Response `201` (`TaskDefinitionResponse`):
```json
{
  "id": "uuid",
  "name": "Blood test",
  "created_at": "2026-02-21T09:00:00+00:00",
  "updated_at": "2026-02-21T09:00:00+00:00"
}
```
- Errors: `400`, `409`, `502`.

### `GET /task-definitions`
- Description: List task definitions.
- Response `200`: `TaskDefinitionResponse[]`.
- Errors: `502`.

### `GET /task-definitions/{task_definition_id}`
- Description: Get task definition by UUID.
- Response `200`: `TaskDefinitionResponse`.
- Errors: `404`, `502`.

### `PUT /task-definitions/{task_definition_id}`
- Description: Update task definition name.
- Request body:
```json
{
  "name": "Updated name"
}
```
- Response `200`: `TaskDefinitionResponse`.
- Errors: `400`, `404`, `409`, `502`.

### `DELETE /task-definitions/{task_definition_id}`
- Description: Delete task definition.
- Response `204`: empty body.
- Errors: `404`, `409`, `502`.

## Patient Tasks

### `POST /patients/{patient_id}/tasks`
- Description: Assign a task definition to a patient. Triggers automatic schedule replan.
- Path params:
  - `patient_id` (external string ID)
- Request body:
```json
{
  "task_definition_id": "uuid",
  "due_at": "2026-02-21T15:00:00Z",
  "status": "pending"
}
```
- Response `201` (`PatientTaskResponse`):
```json
{
  "id": "uuid",
  "patient_id": "uuid",
  "patient_external_id": "P-001",
  "task_definition_id": "uuid",
  "task_name": "Blood test",
  "status": "pending",
  "due_at": "2026-02-21T15:00:00+00:00",
  "created_at": "2026-02-21T09:00:00+00:00",
  "updated_at": "2026-02-21T09:00:00+00:00"
}
```
- Errors: `400`, `404`, `409`, `502`.

### `GET /patients/{patient_id}/tasks`
- Description: List tasks for one patient.
- Path params:
  - `patient_id` (external string ID)
- Query params:
  - `status` (optional): `pending | done | cancelled`
  - Default: `pending`
- Response `200`: `PatientTaskResponse[]`.
- Errors: `404`, `502`.

### `PATCH /patient-tasks/{patient_task_id}`
- Description: Update patient task status and/or due date. Triggers automatic schedule replan.
- Path params:
  - `patient_task_id` (UUID)
- Request body (at least one field):
```json
{
  "status": "done",
  "due_at": "2026-02-21T16:00:00Z"
}
```
- Response `200`: `PatientTaskResponse`.
- Errors: `400`, `404`, `502`.

## Schedule

`POST /schedule` and `GET /schedule` share the same response model:
```json
{
  "items": [
    {
      "schedule_item_id": "uuid",
      "task_name": "Blood test",
      "patient_name": "Elena Ruiz",
      "day": "2026-02-21",
      "hour": 9,
      "priority_score": 41.5,
      "reason": "Time-sensitive lab order"
    }
  ],
  "applied_preferences": {
    "doctor_id": "demo-doctor",
    "source": "mem0",
    "time_blocks_count": 1,
    "overrides_applied_count": 2,
    "scoring_weights": { "w_priority": 10, "w_wait": 0.05 },
    "language": "es"
  },
  "warnings": []
}
```

### `POST /schedule`
- Description: Recompute and synchronize schedule from all pending patient tasks.
- Request body: none.
- Header:
  - `X-Doctor-Id` (optional, fallback to `DEFAULT_DOCTOR_ID`)
- Response `200`: `SchedulePlanResponse`.
- Errors: `400`, `404`, `502`.

### `GET /schedule`
- Description: Return current planned schedule in the same shape as `POST /schedule`.
- Request body: none.
- Response `200`: `SchedulePlanResponse`.
- Errors: `502`.

## Preferences

### `GET /preferences`
- Description: Get planner preferences for a doctor. Falls back to defaults if no Mem0 profile exists.
- Header:
  - `X-Doctor-Id` (optional, fallback to `DEFAULT_DOCTOR_ID`)
- Response `200`:
```json
{
  "doctor_id": "demo-doctor",
  "source": "mem0",
  "preferences": {
    "time_blocks": [{ "start": "13:00", "end": "14:00" }],
    "priority_overrides": [{ "match_type": "contains", "pattern": "K+", "priority": 5, "enabled": true }],
    "scoring_weights": { "w_priority": 10, "w_wait": 0.05 },
    "language": "es",
    "explanations": { "include_reason": true, "include_formula": false }
  },
  "warnings": []
}
```

### `POST /preferences`
- Description: Upsert planner preferences for a doctor.
- Behavior note: `priority_overrides` match against the **patient description** (not task name).
- Header:
  - `X-Doctor-Id` (optional, fallback to `DEFAULT_DOCTOR_ID`)
- Request body (partial update supported):
```json
{
  "time_blocks": [{ "start": "13:00", "end": "14:00" }],
  "priority_overrides": [{ "match_type": "regex", "pattern": "\\bECG\\b", "priority": 4, "enabled": true }],
  "scoring_weights": { "w_priority": 12, "w_wait": 0.04 },
  "language": "es",
  "explanations": { "include_reason": true, "include_formula": false }
}
```
- Response `200`: same shape as `GET /preferences`.
- Errors: `502` when Mem0 is unavailable or not configured.

### `GET /schedule/day/{day}`
- Description: Return schedule for one day.
- Path params:
  - `day` (date, format `YYYY-MM-DD`)
- Response `200`: `SchedulePlanResponse`.
- Errors: `502`.

### `GET /schedule/{patient_id}`
- Description: Return schedule for one patient (external `patient_id`).
- Path params:
  - `patient_id` (string)
- Response `200`: `SchedulePlanResponse`.
- Errors: `404`, `502`.

### `DELETE /schedule/{schedule_item_id}`
- Description:
1. Fetch schedule item.
2. Cancel source `patient_task` (if linked).
3. Delete schedule item.
4. Trigger automatic replan.
- Path params:
  - `schedule_item_id` (UUID)
- Response `204`: empty body.
- Errors: `400`, `404`, `502`.
