from __future__ import annotations

import logging
from time import perf_counter

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.config import configure_logging, get_settings
from app.intake_voice.router import router as voice_intake_router
from app.models.schemas import HealthResponse
from app.routers.patients import router as patients_router
from app.routers.preferences import router as preferences_router
from app.routers.schedule import router as schedule_router
from app.routers.task_definitions import router as task_definitions_router
from app.routers.tasks import router as tasks_router

settings = get_settings()
configure_logging(settings.log_level)
logger = logging.getLogger(__name__)

app = FastAPI(title="HackEurope2026 Backend", version="0.2.0")

default_origins = {
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://cliniclar-l0yqlbnoh-talens-projects-00dca8ad.vercel.app",
}
if settings.cors_allow_origins:
    env_origins = {origin.strip() for origin in settings.cors_allow_origins.split(",") if origin.strip()}
    default_origins.update(env_origins)

app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(default_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(patients_router)
app.include_router(preferences_router)
app.include_router(task_definitions_router)
app.include_router(tasks_router)
app.include_router(schedule_router)
app.include_router(voice_intake_router)


@app.middleware("http")
async def request_logging_middleware(request: Request, call_next):
    request_id = request.headers.get("x-request-id", "-")
    started_at = perf_counter()

    try:
        response = await call_next(request)
    except Exception:  # noqa: BLE001
        elapsed_ms = (perf_counter() - started_at) * 1000
        logger.exception(
            "request_failed method=%s path=%s request_id=%s duration_ms=%.2f",
            request.method,
            request.url.path,
            request_id,
            elapsed_ms,
        )
        raise

    elapsed_ms = (perf_counter() - started_at) * 1000
    logger.info(
        "request_complete method=%s path=%s status_code=%s request_id=%s duration_ms=%.2f",
        request.method,
        request.url.path,
        response.status_code,
        request_id,
        elapsed_ms,
    )
    return response


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", env=settings.env)
