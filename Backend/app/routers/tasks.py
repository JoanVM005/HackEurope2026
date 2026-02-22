from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.db.supabase_client import (
    ConflictError,
    NotFoundError,
    SupabaseRepository,
    UpstreamServiceError,
    ValidationError,
    get_repository,
)
from app.llm.openai_client import OpenAIPlannerClient, get_openai_planner_client
from app.models.schemas import (
    PatientTaskAssignCreate,
    PatientTaskResponse,
    PatientTaskUpdate,
    TaskStatus,
)
from app.services.planner import PlannerService, PlannerValidationError
from app.services.preferences_service import PreferencesService, get_preferences_service

router = APIRouter(tags=["patient-tasks"])


def get_planner_service(
    repository: SupabaseRepository = Depends(get_repository),
    llm_client: OpenAIPlannerClient = Depends(get_openai_planner_client),
    preferences_service: PreferencesService = Depends(get_preferences_service),
) -> PlannerService:
    return PlannerService(
        repository=repository,
        llm_client=llm_client,
        preferences_service=preferences_service,
    )


@router.post(
    "/patients/{patient_id}/tasks",
    response_model=PatientTaskResponse,
    status_code=status.HTTP_201_CREATED,
)
def assign_task_to_patient(
    patient_id: int,
    payload: PatientTaskAssignCreate,
    repository: SupabaseRepository = Depends(get_repository),
    planner_service: PlannerService = Depends(get_planner_service),
) -> PatientTaskResponse:
    try:
        created = repository.create_patient_task(patient_id, payload)
        planner_service.replan_and_sync()
        return created
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except PlannerValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.get("/patients/{patient_id}/tasks", response_model=list[PatientTaskResponse])
def list_tasks_for_patient(
    patient_id: int,
    status_filter: TaskStatus = Query(default=TaskStatus.pending, alias="status"),
    repository: SupabaseRepository = Depends(get_repository),
) -> list[PatientTaskResponse]:
    try:
        return repository.list_patient_tasks(patient_id, status=status_filter)
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.patch("/patient-tasks/{patient_task_id}", response_model=PatientTaskResponse)
def update_patient_task(
    patient_task_id: UUID,
    payload: PatientTaskUpdate,
    repository: SupabaseRepository = Depends(get_repository),
    planner_service: PlannerService = Depends(get_planner_service),
) -> PatientTaskResponse:
    try:
        updated = repository.update_patient_task(patient_task_id=patient_task_id, payload=payload)
        planner_service.replan_and_sync()
        return updated
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except PlannerValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
