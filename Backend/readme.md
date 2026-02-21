# HackEurope2026 Backend MVP (FastAPI)

Backend para MVP de hackathon con:
- CRUD de pacientes
- Catálogo fijo de tipos de tarea (`task_definitions`)
- Asignaciones de tareas a pacientes (`patient_tasks`) con unicidad por paciente+tarea
- Planificación de schedule con OpenAI + score determinista en backend
- Auto-replan síncrono cuando cambian asignaciones de tareas

## Breaking changes (v0.2.0)
- Las tareas ya no son libres por paciente con `title/details`.
- Existe catálogo global `task_definitions` con campo único `name`.
- Se unificó planificación en `POST /schedule` (se elimina `/schedule/plan`).
- `POST /schedule` devuelve: `task_name`, `patient_name`, `day`, `hour` (9..21), `priority_score`, `reason`.
- `POST /schedule` no recibe body y siempre persiste en `schedule_items`.

## Requisitos
- Python 3.12+
- Proyecto Supabase (Postgres)
- OpenAI API key

## Setup
```bash
cd /Users/joanvm/Desktop/Projects/Hackathon/HackEurope2026/HackEurope2026/Backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Variables de entorno
- `SUPABASE_URL` (required)
- `SUPABASE_KEY` (required)
- `OPENAI_API_KEY` (required)
- `OPENAI_MODEL` (default: `gpt-4o-mini`)
- `ENV` (default: `dev`)
- `LOG_LEVEL` (default: `INFO`)

## Base de datos
Aplica `/Users/joanvm/Desktop/Projects/Hackathon/HackEurope2026/HackEurope2026/Backend/supabase_schema.sql` en Supabase SQL Editor.

## Ejecutar
```bash
cd /Users/joanvm/Desktop/Projects/Hackathon/HackEurope2026/HackEurope2026/Backend
uvicorn app.main:app --reload
```

Con venv explícito:
```bash
/Users/joanvm/Desktop/Projects/Hackathon/HackEurope2026/HackEurope2026/Backend/.venv/bin/uvicorn app.main:app --reload
```

## Endpoints

### Health
#### `GET /health`
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

### Task Definitions (catálogo)
- `POST /task-definitions`
- `GET /task-definitions`
- `GET /task-definitions/{task_definition_id}`
- `PUT /task-definitions/{task_definition_id}`
- `DELETE /task-definitions/{task_definition_id}`

Crear task definition:
```json
{
  "name": "Blood test"
}
```

### Patient Tasks (asignaciones)
- `POST /patients/{patient_id}/tasks`
- `GET /patients/{patient_id}/tasks?status=pending`
- `PATCH /patient-tasks/{patient_task_id}`

`POST` y `PATCH` disparan replan automático del scheduler.

Asignar tarea de catálogo a paciente:
```json
{
  "task_definition_id": "5e7f0f13-3f44-4d74-ab17-0f1266d2c0a1",
  "due_at": "2026-02-21T15:00:00Z",
  "status": "pending"
}
```

### Schedule
- `GET /schedule`
- `GET /schedule/day/{day}` (formato `YYYY-MM-DD`)
- `GET /schedule/{patient_id}` (patient_id externo)
- `POST /schedule`
- `DELETE /schedule/{schedule_item_id}`

Planificar (DB-only, sin body): ejecutar `POST /schedule` directamente.
`GET /schedule` devuelve el mismo formato de respuesta que `POST /schedule`.
`DELETE /schedule/{schedule_item_id}`:
1. Cancela la `patient_task` origen (si existe `source_patient_task_id`).
2. Elimina el item de agenda.
3. Ejecuta replan automático para compactar huecos.

Respuesta:
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
  ]
}
```

## Lógica de priorización
1. Se intenta Structured Outputs estricto con JSON Schema en OpenAI Responses API.
2. Si no está soportado por modelo/config, fallback a JSON mode y validación local.
3. Si falla llamada/parsing, fallback final:
   - `priority = 3`
   - `confidence = 0`
   - `reason = "fallback"`
4. Score determinista en backend:
   - `waiting_minutes = max(0, now_utc - admitted_at)`
   - `score = priority * 10 + waiting_minutes * 0.05`
5. El orden final SIEMPRE usa `score DESC`.
6. Restricciones de agenda:
   - Un paciente no puede tener más de una tarea en la misma hora.
   - No puede haber dos pacientes en la misma tarea a la misma hora.
7. Todas las tareas se asignan empezando desde las 09:00 y se desplazan por horas sucesivas; si no hay hueco, continúan en días siguientes.
8. El planner cachea resultado LLM por `patient_task` y reutiliza prioridad si el contexto no cambió.
9. La persistencia usa sincronización por diff sobre tareas futuras para evitar reinserciones completas.
