from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.db.supabase_client import (
    ConflictError,
    NotFoundError,
    SupabaseRepository,
    UpstreamServiceError,
    ValidationError,
    get_repository,
)
from app.llm.openai_client import get_openai_planner_client
from app.models.schemas import (
    PatientCreate,
    PatientResponse,
    PatientUpdate,
    PriorityPreviewRequest,
    PriorityPreviewResponse,
)

router = APIRouter(tags=["patients"])


@router.post("/patients", response_model=PatientResponse, status_code=status.HTTP_201_CREATED)
def create_patient(
    payload: PatientCreate,
    repository: SupabaseRepository = Depends(get_repository),
) -> PatientResponse:
    try:
        return repository.create_patient(payload)
    except ConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.get("/patients", response_model=list[PatientResponse])
def list_patients(
    repository: SupabaseRepository = Depends(get_repository),
) -> list[PatientResponse]:
    try:
        return repository.list_patients()
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.get("/patients/{patient_id}", response_model=PatientResponse)
def get_patient(
    patient_id: int,
    repository: SupabaseRepository = Depends(get_repository),
) -> PatientResponse:
    try:
        return repository.get_patient_by_external_id(patient_id)
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.put("/patients/{patient_id}", response_model=PatientResponse)
def update_patient(
    patient_id: int,
    payload: PatientUpdate,
    repository: SupabaseRepository = Depends(get_repository),
) -> PatientResponse:
    try:
        return repository.update_patient(patient_id, payload)
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.delete("/patients/{patient_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_patient(
    patient_id: int,
    repository: SupabaseRepository = Depends(get_repository),
) -> None:
    try:
        repository.delete_patient(patient_id)
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
@router.post("/patients/priority-preview", response_model=PriorityPreviewResponse)
def preview_priority(
    payload: PriorityPreviewRequest,
) -> PriorityPreviewResponse:
    llm_client = get_openai_planner_client()

    summary_parts = []
    if payload.time_preferences:
        summary_parts.append(f"time_preferences={payload.time_preferences}")
    if payload.admitted_at:
        summary_parts.append(f"admitted_at={payload.admitted_at.isoformat()}")
    if payload.task_names:
        summary_parts.append(f"tasks={', '.join(payload.task_names)}")

    task_details = "; ".join(summary_parts) if summary_parts else None
    llm_result = llm_client.estimate_priority(
        patient_description=payload.description,
        task_title="Initial patient intake priority",
        task_details=task_details,
    )

    return PriorityPreviewResponse(
        suggested_priority=llm_result.priority,
        confidence=llm_result.confidence,
        model_reason=llm_result.reason,
    )
