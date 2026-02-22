# Cliniclár · HackEurope2026

Plataforma MVP para orquestar flujo clínico hospitalario con dos entradas principales:
- **Intake manual o por voz** para registrar pacientes.
- **Planificación automática de agenda** basada en prioridad clínica-operativa + reglas determinísticas.

El objetivo es reducir tiempo de coordinación clínica: desde la captura inicial hasta un calendario accionable por horas.

## Qué resuelve

- Alta de pacientes con metadatos de prioridad y justificación médica.
- Sugerencia de prioridad con LLM antes de confirmar el alta.
- Catálogo global de tareas (tests/procedimientos) y asignación por paciente.
- Planificador que distribuye tareas en slots horarios respetando restricciones.
- Replanificación automática al cambiar tareas/estado.
- Flujo de intake por voz con:
  - transcripción (ElevenLabs),
  - extracción de slots estructurados,
  - generación de PDF de transcript,
  - revisión médica previa a confirmar paciente/tareas.
- Configuración de preferencias del planificador por médico (Mem0):
  - bloques horarios a evitar,
  - reglas de override de prioridad,
  - pesos de scoring.

## Arquitectura

### Backend (FastAPI)

Ruta: `Backend/app`

Módulos principales:
- `main.py`: inicialización app, CORS, logging, routers.
- `routers/`:
  - `patients.py`: CRUD de pacientes + `priority-preview`.
  - `task_definitions.py`: CRUD catálogo global de tareas.
  - `tasks.py`: asignación/actualización de tareas por paciente.
  - `schedule.py`: plan/replan, completar tareas, remove-flow y reprogramación.
  - `preferences.py`: lectura/escritura de preferencias del planner.
- `services/planner.py`:
  - score determinístico,
  - caché de prioridad LLM por contexto,
  - asignación de slots con restricciones y sesgo suave por `time_preferences`,
  - sincronización incremental contra `schedule_items`.
- `intake_voice/`:
  - sesión conversacional por turnos,
  - extracción de slots con OpenAI Responses API,
  - finalización a `pending_review`,
  - confirmación que crea paciente+tareas y dispara replan.
- `db/supabase_client.py`: repositorio central de acceso a Supabase.
- `llm/openai_client.py`: priorización y normalización de preferencias horarias con fallback robusto.
- `memory/mem0_client.py`: persistencia/lectura de preferencias por médico.
- `transcription/elevenlabs_client.py`: STT de audio.
- `pdf/transcript_pdf_service.py`: generación de transcript PDF.

### Frontend (React + TypeScript + Vite)

Ruta: `Frontend/hackeurope2026/src`

Pantallas y features:
- `pages/LandingPage.tsx`: entrada al flujo.
- `features/patient-board/PatientBoardPage.tsx`:
  - intake manual con preview de prioridad,
  - intake por voz (grabación + fallback texto),
  - revisión de pendientes de voz,
  - edición/eliminación de paciente,
  - gestión de tareas por paciente.
- `schedule/ScheduleGrid.tsx`:
  - grilla por hora × tarea,
  - filtros por día/paciente,
  - replan con ventana horaria,
  - completar tareas,
  - remove-flow para reprogramar o cancelar tareas.
- `features/preferences/PreferencesPage.tsx`:
  - time blocks,
  - overrides de prioridad,
  - pesos de scoring.

## Modelo de datos

Archivo principal de esquema: `Backend/supabase_schema.sql`

Entidades clave:
- `patients`
- `patient_priority_feedback` (auditoría)
- `task_definitions`
- `patient_tasks`
- `schedule_items`
- `voice_intake_sessions`
- `voice_intake_turns`

Notas relevantes:
- Restricciones de unicidad para evitar colisiones de agenda por paciente/tarea-hora.
- Check constraints para rangos válidos (`priority`, `confidence`, estados).
- Bucket de storage `voice-intake-transcripts` para PDFs.

## Endpoints

Referencia completa con payloads y respuestas:
- `Backend/API_ENDPOINTS.md`

Resumen:
- `GET /health`
- `POST/GET/PUT/DELETE /patients`
- `POST /patients/priority-preview`
- `POST/GET/PUT/DELETE /task-definitions`
- `POST /patients/{patient_id}/tasks`
- `GET /patients/{patient_id}/tasks`
- `PATCH /patient-tasks/{patient_task_id}`
- `POST/GET /schedule`
- `POST /schedule/complete`
- `POST /schedule/{id}/remove-flow/start`
- `POST /schedule/{id}/remove-flow/apply`
- `POST /schedule/{id}/remove-flow/cancel-task`
- `GET /schedule/day/{day}`
- `GET /schedule/{patient_id}`
- `GET/POST /preferences`
- `POST /voice-intake/sessions`
- `GET /voice-intake/sessions`
- `POST /voice-intake/sessions/{id}/transcribe`
- `POST /voice-intake/sessions/{id}/turn`
- `POST /voice-intake/sessions/{id}/finalize`
- `POST /voice-intake/sessions/{id}/confirm`

## Setup rápido

### 1) Backend

```bash
cd Backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Crear `Backend/.env` con al menos:
- `SUPABASE_URL`
- `SUPABASE_KEY`
- `OPENAI_API_KEY`

Opcionales según features:
- `ELEVENLABS_API_KEY`
- `MEM0_API_KEY`
- `MEM0_PROJECT_ID`
- `DEFAULT_DOCTOR_ID`
- `OPENAI_MODEL`
- `VOICE_TRANSCRIPT_BUCKET`
- `CORS_ALLOW_ORIGINS`

Aplicar esquema:
- ejecutar `Backend/supabase_schema.sql` en Supabase SQL Editor.

Levantar API:

```bash
cd Backend
uvicorn app.main:app --reload
```

### 2) Frontend

```bash
cd Frontend/hackeurope2026
npm install
```

Variables recomendadas:
- `VITE_API_BASE_URL=http://127.0.0.1:8000`
- `VITE_DOCTOR_ID=demo-doctor`

Ejecutar:

```bash
npm run dev
```

## Calidad y observaciones técnicas (evaluación)

Fortalezas:
- Separación clara por capas (routers, servicios, repositorio, modelos).
- Reglas de negocio explícitas con validación tanto en Pydantic como SQL.
- Estrategia de fallback para LLM y STT que evita caída total del flujo.
- Planificador con sincronización incremental (no reinserción completa indiscriminada).
- UX front-end cubre flujo end-to-end: intake -> review -> schedule -> ajustes.

Riesgos/mejoras detectadas:
- **Seguridad**: existe archivo `Backend/.env` en el repositorio local con credenciales reales; se recomienda rotación inmediata y migrar a secretos fuera de git.
- **Consistencia de entorno front**: `src/schedule/scheduleApi.ts` mezcla llamadas vía `apiRequest` y `fetch('/api/...')`; en producción requiere asegurar routing/proxy equivalente.
- **Datos de prueba**: `Backend/Test/seed_test_data.sql` contiene inconsistencias de tipo/formato en `patient_id` respecto al esquema actual (`int`).
- **Cobertura de tests**: hay script de validación funcional (`Backend/Test/test_schedule_order.sh`), pero falta una suite automática unitaria/integración más amplia.

## Estructura del repositorio

```text
.
├── Backend
│   ├── app
│   ├── Test
│   ├── API_ENDPOINTS.md
│   └── supabase_schema.sql
├── Frontend
│   └── hackeurope2026
└── README.md
```

## Estado actual

MVP funcional para demo hackathon, con flujo completo desde intake (manual/voz) hasta planificación clínica y ajustes operativos de agenda.
