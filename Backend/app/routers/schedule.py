from __future__ import annotations

import logging
from datetime import date
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status

from app.db.supabase_client import (
    NotFoundError,
    SupabaseRepository,
    UpstreamServiceError,
    get_repository,
)
from app.llm.openai_client import OpenAIPlannerClient, get_openai_planner_client
from app.models.schemas import (
    SchedulePlanResponse,
)
from app.services.planner import PlannerService, PlannerValidationError

router = APIRouter(prefix="/schedule", tags=["schedule"])
logger = logging.getLogger(__name__)


def get_planner_service(
    repository: SupabaseRepository = Depends(get_repository),
    llm_client: OpenAIPlannerClient = Depends(get_openai_planner_client),
) -> PlannerService:
    return PlannerService(repository=repository, llm_client=llm_client)


@router.post("", response_model=SchedulePlanResponse)
def plan_schedule(
    planner_service: PlannerService = Depends(get_planner_service),
) -> SchedulePlanResponse:
    try:
        return planner_service.replan_and_sync()
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except PlannerValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.get("", response_model=SchedulePlanResponse)
def list_schedule(
    repository: SupabaseRepository = Depends(get_repository),
) -> SchedulePlanResponse:
    try:
        items = repository.list_schedule_plan_items()
        return SchedulePlanResponse(items=items)
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.get("/day/{day}", response_model=SchedulePlanResponse)
def list_schedule_by_day(
    day: date,
    repository: SupabaseRepository = Depends(get_repository),
) -> SchedulePlanResponse:
    try:
        items = repository.list_schedule_plan_items(schedule_day=day)
        return SchedulePlanResponse(items=items)
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.get("/{patient_id}", response_model=SchedulePlanResponse)
def list_schedule_by_patient(
    patient_id: int,
    repository: SupabaseRepository = Depends(get_repository),
) -> SchedulePlanResponse:
    try:
        items = repository.list_schedule_plan_items(patient_external_id=patient_id)
        return SchedulePlanResponse(items=items)
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.delete("/{schedule_item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_schedule_item(
    schedule_item_id: UUID,
    repository: SupabaseRepository = Depends(get_repository),
    planner_service: PlannerService = Depends(get_planner_service),
) -> None:
    try:
        schedule_item = repository.get_schedule_item(schedule_item_id)
        if schedule_item.source_patient_task_id is not None:
            repository.cancel_patient_task(schedule_item.source_patient_task_id)
        else:
            logger.warning(
                "Deleting schedule item without source_patient_task_id schedule_item_id=%s",
                schedule_item_id,
            )
        repository.delete_schedule_item(schedule_item_id)
        planner_service.replan_and_sync()
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except PlannerValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
