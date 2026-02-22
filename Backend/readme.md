# HackEurope2026 Backend MVP (FastAPI)

Backend for a hackathon MVP with:
- Patient CRUD
- Fixed global task catalog (`task_definitions`)
- Patient task assignments (`patient_tasks`) with unique `(patient, task)`
- Schedule planning with OpenAI + deterministic backend scoring
- Synchronous auto-replan when patient tasks change

## Breaking Changes (v0.2.0)
- Tasks are no longer free-form (`title/details`) per patient.
- A global `task_definitions` catalog is now enforced with unique `name`.
- Planning is unified under `POST /schedule` (`/schedule/plan` removed).
- `POST /schedule` requires no body and always persists in `schedule_items`.
- `GET /schedule` now returns the same payload shape as `POST /schedule`.

## Requirements
- Python 3.12+
- Supabase project (Postgres)
- OpenAI API key

## Setup
```bash
cd /Users/joanvm/Desktop/Projects/Hackathon/HackEurope2026/HackEurope2026/Backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Environment Variables
- `SUPABASE_URL` (required)
- `SUPABASE_KEY` (required)
- `OPENAI_API_KEY` (required)
- `OPENAI_MODEL` (default: `gpt-4o-mini`)
- `MEM0_API_KEY` (optional for read fallback, required to persist `/preferences`)
- `MEM0_PROJECT_ID` (optional; recommended to isolate memory context)
- `MEM0_ORG_ID` (optional)
- `DEFAULT_DOCTOR_ID` (default: `demo-doctor`)
- `ENV` (default: `dev`)
- `LOG_LEVEL` (default: `INFO`)

## Database
Apply:
`/Users/joanvm/Desktop/Projects/Hackathon/HackEurope2026/HackEurope2026/Backend/supabase_schema.sql`
in the Supabase SQL Editor.

## Run
```bash
cd /Users/joanvm/Desktop/Projects/Hackathon/HackEurope2026/HackEurope2026/Backend
uvicorn app.main:app --reload
```

With explicit venv:
```bash
/Users/joanvm/Desktop/Projects/Hackathon/HackEurope2026/HackEurope2026/Backend/.venv/bin/uvicorn app.main:app --reload
```

## Endpoints

### Health
- `GET /health`

Response:
```json
{
  "status": "ok",
  "env": "dev"
}
```

### Patients
- `POST /patients`
- `GET /patients`
- `GET /patients/{patient_id}`
- `PUT /patients/{patient_id}`
- `DELETE /patients/{patient_id}`

### Task Definitions
- `POST /task-definitions`
- `GET /task-definitions`
- `GET /task-definitions/{task_definition_id}`
- `PUT /task-definitions/{task_definition_id}`
- `DELETE /task-definitions/{task_definition_id}`

Example create payload:
```json
{
  "name": "Blood test"
}
```

### Patient Tasks
- `POST /patients/{patient_id}/tasks`
- `GET /patients/{patient_id}/tasks?status=pending`
- `PATCH /patient-tasks/{patient_task_id}`

`POST` and `PATCH` trigger automatic schedule replanning.

Example assignment payload:
```json
{
  "task_definition_id": "5e7f0f13-3f44-4d74-ab17-0f1266d2c0a1",
  "due_at": "2026-02-21T15:00:00Z",
  "status": "pending"
}
```

### Schedule
- `POST /schedule`
- `GET /schedule`
- `GET /schedule/day/{day}` (`YYYY-MM-DD`)
- `GET /schedule/{patient_id}` (external `patient_id`)
- `DELETE /schedule/{schedule_item_id}`

Notes:
- `POST /schedule` requires no request body.
- `POST /schedule` reads doctor memory with `X-Doctor-Id` (fallback: `DEFAULT_DOCTOR_ID`).
- `GET /schedule` returns the same structure as `POST /schedule`.
- `DELETE /schedule/{schedule_item_id}`:
1. Cancels the source `patient_task` (if `source_patient_task_id` exists)
2. Deletes the schedule row
3. Triggers automatic replanning

Response shape for `POST /schedule` and `GET /schedule`:
```json
{
  "items": [
    {
      "schedule_item_id": "7a2d8c34-e7f8-4a3a-98a1-4fa5a4c4b2f6",
      "task_name": "Blood test",
      "patient_name": "Ana Lopez",
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

### Preferences
- `GET /preferences` (reads from Mem0, or defaults when unavailable/no memory)
- `POST /preferences` (upsert doctor preferences into Mem0)
- `priority_overrides` are evaluated against patient description text.

Both endpoints read `X-Doctor-Id` header (fallback: `DEFAULT_DOCTOR_ID`).

## Prioritization and Scheduling Logic
1. The planner first attempts strict Structured Outputs (JSON Schema) via OpenAI Responses API.
2. If unsupported by model/config, it falls back to JSON mode plus local validation.
3. If parsing/call fails, fallback is:
   - `priority = 3`
   - `confidence = 0`
   - `reason = "fallback"`
4. Deterministic score:
   - `waiting_minutes = max(0, now_utc - admitted_at)`
   - `score = priority * 10 + waiting_minutes * 0.05`
5. Final ordering always uses deterministic score.
6. Constraints:
   - A patient cannot have more than one task in the same hour.
   - Two patients cannot have the same task at the same hour.
7. Planning always allocates from 09:00 forward to 21:00; overflow continues on following days.
8. LLM output is cached per `patient_task` and reused when context is unchanged.
9. Persistence uses a diff-based sync over future slots to avoid full reinsertion.

## API Contract Reference
See:
`/Users/joanvm/Desktop/Projects/Hackathon/HackEurope2026/HackEurope2026/Backend/API_ENDPOINTS.md`
for complete request/response details per endpoint.
