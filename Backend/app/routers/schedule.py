from __future__ import annotations

import logging
from datetime import date
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Header, HTTPException, status

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
    RemoveFlowApplyRequest,
    RemoveFlowApplyResponse,
    RemoveFlowCancelResponse,
    RemoveFlowStartResponse,
    ScheduleCompleteRequest,
    ScheduleCompleteResponse,
    ScheduleItemResponse,
    ScheduleRescheduleRequest,
    ScheduleRescheduleResponse,
    ScheduleRescheduleOptionsResponse,
    ScheduleItemStatus,
    SchedulePlanRequest,
    SchedulePlanResponse,
)
from app.services.planner import PlannerService, PlannerValidationError
from app.services.preferences_service import PreferencesService, get_preferences_service

router = APIRouter(prefix="/schedule", tags=["schedule"])
logger = logging.getLogger(__name__)


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


def _build_reschedule_conflict_detail(
    message: str,
    options_response: ScheduleRescheduleOptionsResponse,
) -> dict[str, object]:
    return {
        "message": message,
        "options": [option.model_dump(mode="json") for option in options_response.options],
        "warnings": options_response.warnings,
    }


def _ensure_pending_remove_item(
    schedule_item: ScheduleItemResponse,
    require_task_definition: bool = True,
) -> None:
    if schedule_item.status != ScheduleItemStatus.pending:
        raise ValidationError("Only pending schedule items can be used in remove flow")
    if schedule_item.source_patient_task_id is None:
        raise ValidationError("Schedule item has no source patient task")
    if require_task_definition and schedule_item.task_definition_id is None:
        raise ValidationError("Schedule item has no task definition")


@router.post("", response_model=SchedulePlanResponse)
def plan_schedule(
    payload: SchedulePlanRequest | None = Body(default=None),
    x_doctor_id: str | None = Header(default=None, alias="X-Doctor-Id"),
    planner_service: PlannerService = Depends(get_planner_service),
) -> SchedulePlanResponse:
    try:
        return planner_service.replan_and_sync(
            doctor_id=x_doctor_id,
            clinic_start_hour=payload.clinic_start_hour if payload else None,
            clinic_end_hour=payload.clinic_end_hour if payload else None,
        )
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


@router.post("/{schedule_item_id}/remove-flow/start", response_model=RemoveFlowStartResponse)
def start_remove_flow(
    schedule_item_id: UUID,
    repository: SupabaseRepository = Depends(get_repository),
    planner_service: PlannerService = Depends(get_planner_service),
) -> RemoveFlowStartResponse:
    try:
        original_item = repository.get_schedule_item(schedule_item_id)
        _ensure_pending_remove_item(original_item, require_task_definition=True)
        if original_item.source_patient_task_id is None:
            raise ValidationError("Schedule item has no source patient task")

        source_task_id = original_item.source_patient_task_id
        original_scheduled_for = original_item.scheduled_for

        repository.delete_schedule_item(schedule_item_id)
        planner_service.replan_and_sync()

        working_item = repository.find_schedule_item_by_source_task_id(source_task_id)
        _ensure_pending_remove_item(working_item, require_task_definition=True)
        options_response = repository.list_three_consecutive_options(
            schedule_item_id=working_item.id,
            anchor_scheduled_for=original_scheduled_for,
        )
        if len(options_response.options) < 3:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=_build_reschedule_conflict_detail(
                    message="No block of 3 consecutive free slots is currently available.",
                    options_response=options_response,
                ),
            )

        return RemoveFlowStartResponse(
            original_schedule_item_id=original_item.id,
            working_schedule_item_id=working_item.id,
            source_patient_task_id=source_task_id,
            options=options_response.options,
            warnings=options_response.warnings,
        )
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except PlannerValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.post("/{working_schedule_item_id}/remove-flow/apply", response_model=RemoveFlowApplyResponse)
def apply_remove_flow(
    working_schedule_item_id: UUID,
    payload: RemoveFlowApplyRequest,
    repository: SupabaseRepository = Depends(get_repository),
) -> RemoveFlowApplyResponse:
    try:
        working_item = repository.get_schedule_item(working_schedule_item_id)
        _ensure_pending_remove_item(working_item, require_task_definition=True)
        if working_item.task_definition_id is None:
            raise ValidationError("Schedule item has no task definition")

        is_free = repository.is_slot_free_for_task_and_patient(
            patient_id=working_item.patient_id,
            task_definition_id=working_item.task_definition_id,
            scheduled_for=payload.scheduled_for,
            exclude_schedule_item_id=working_item.id,
        )
        if not is_free:
            refreshed_options = repository.list_three_consecutive_options(
                schedule_item_id=working_item.id,
                anchor_scheduled_for=payload.scheduled_for,
            )
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=_build_reschedule_conflict_detail(
                    message="Selected slot is no longer available.",
                    options_response=refreshed_options,
                ),
            )

        try:
            updated_item = repository.update_schedule_item(
                schedule_item_id=working_item.id,
                payload={"scheduled_for": payload.scheduled_for.isoformat()},
            )
        except ConflictError as exc:
            refreshed_options = repository.list_three_consecutive_options(
                schedule_item_id=working_item.id,
                anchor_scheduled_for=payload.scheduled_for,
            )
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=_build_reschedule_conflict_detail(
                    message="Selected slot is no longer available.",
                    options_response=refreshed_options,
                ),
            ) from exc

        return RemoveFlowApplyResponse(
            schedule_item_id=updated_item.id,
            scheduled_for=updated_item.scheduled_for,
            notice="Task rescheduled successfully.",
        )
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.post("/{working_schedule_item_id}/remove-flow/cancel-task", response_model=RemoveFlowCancelResponse)
def cancel_task_from_remove_flow(
    working_schedule_item_id: UUID,
    repository: SupabaseRepository = Depends(get_repository),
    planner_service: PlannerService = Depends(get_planner_service),
) -> RemoveFlowCancelResponse:
    try:
        working_item = repository.get_schedule_item(working_schedule_item_id)
        _ensure_pending_remove_item(working_item, require_task_definition=False)
        if working_item.source_patient_task_id is None:
            raise ValidationError("Schedule item has no source patient task")

        source_task_id = working_item.source_patient_task_id
        repository.cancel_patient_task(source_task_id)
        repository.delete_schedule_item(working_schedule_item_id)
        planner_service.replan_and_sync()

        return RemoveFlowCancelResponse(
            schedule_item_id=working_item.id,
            source_patient_task_id=source_task_id,
            notice="Task cancelled successfully.",
        )
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except PlannerValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.get("/{schedule_item_id}/reschedule-options", response_model=ScheduleRescheduleOptionsResponse)
def get_reschedule_options(
    schedule_item_id: UUID,
    repository: SupabaseRepository = Depends(get_repository),
) -> ScheduleRescheduleOptionsResponse:
    try:
        return repository.list_next_reschedule_options(schedule_item_id=schedule_item_id, limit=3)
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.post("/{schedule_item_id}/reschedule", response_model=ScheduleRescheduleResponse)
def reschedule_item(
    schedule_item_id: UUID,
    payload: ScheduleRescheduleRequest,
    repository: SupabaseRepository = Depends(get_repository),
    planner_service: PlannerService = Depends(get_planner_service),
) -> ScheduleRescheduleResponse:
    try:
        original_item = repository.get_schedule_item(schedule_item_id)
        if original_item.status != ScheduleItemStatus.pending:
            raise ValidationError("Only pending schedule items can be rescheduled")
        if original_item.source_patient_task_id is None:
            raise ValidationError("Schedule item has no source patient task")
        if original_item.task_definition_id is None:
            raise ValidationError("Schedule item has no task definition")

        source_task_id = original_item.source_patient_task_id

        # Keep task metadata in memory via source_task_id; delete only the current slot.
        repository.delete_schedule_item(schedule_item_id)
        planner_service.replan_and_sync()

        replanned_item = repository.find_schedule_item_by_source_task_id(source_task_id)
        if replanned_item.task_definition_id is None:
            raise ValidationError("Replanned schedule item has no task definition")

        is_free = repository.is_slot_free_for_task_and_patient(
            patient_id=replanned_item.patient_id,
            task_definition_id=replanned_item.task_definition_id,
            scheduled_for=payload.scheduled_for,
            exclude_schedule_item_id=replanned_item.id,
        )
        if not is_free:
            refreshed_options = repository.list_next_reschedule_options(schedule_item_id=replanned_item.id, limit=3)
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=_build_reschedule_conflict_detail(
                    message="Selected slot is no longer available.",
                    options_response=refreshed_options,
                ),
            )

        try:
            updated_item = repository.update_schedule_item(
                schedule_item_id=replanned_item.id,
                payload={"scheduled_for": payload.scheduled_for.isoformat()},
            )
        except ConflictError as exc:
            refreshed_options = repository.list_next_reschedule_options(schedule_item_id=replanned_item.id, limit=3)
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=_build_reschedule_conflict_detail(
                    message="Selected slot is no longer available.",
                    options_response=refreshed_options,
                ),
            ) from exc

        return ScheduleRescheduleResponse(
            schedule_item_id=updated_item.id,
            scheduled_for=updated_item.scheduled_for,
            notice="Task rescheduled successfully.",
        )
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except PlannerValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.post("/complete", response_model=ScheduleCompleteResponse)
def complete_schedule_items(
    payload: ScheduleCompleteRequest,
    repository: SupabaseRepository = Depends(get_repository),
    planner_service: PlannerService = Depends(get_planner_service),
) -> ScheduleCompleteResponse:
    try:
        result = repository.complete_schedule_items(payload.schedule_item_ids)
        planner_service.replan_and_sync()
        return result
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except PlannerValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
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
        if (
            schedule_item.source_patient_task_id is not None
            and schedule_item.status == ScheduleItemStatus.pending
        ):
            repository.cancel_patient_task(schedule_item.source_patient_task_id)
        elif schedule_item.source_patient_task_id is None:
            logger.warning(
                "Deleting schedule item without source_patient_task_id schedule_item_id=%s",
                schedule_item_id,
            )
        else:
            logger.info(
                "Deleting completed schedule item without cancelling source task schedule_item_id=%s",
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
