from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from typing import Any
from uuid import UUID

from supabase import Client, create_client

from app.config import get_settings
from app.models.schemas import (
    PatientCreate,
    PatientResponse,
    PlannedScheduleItem,
    PlannerLlmCacheUpdate,
    PatientTaskAssignCreate,
    PatientTaskResponse,
    PatientTaskUpdate,
    PatientUpdate,
    PlannerTaskContext,
    ScheduleItemResponse,
    TaskDefinitionCreate,
    TaskDefinitionResponse,
    TaskDefinitionUpdate,
    TaskStatus,
)

logger = logging.getLogger(__name__)


class RepositoryError(Exception):
    """Base repository exception."""


class NotFoundError(RepositoryError):
    """Raised when an entity cannot be found."""


class ConflictError(RepositoryError):
    """Raised when uniqueness or foreign key constraints are violated."""


class ValidationError(RepositoryError):
    """Raised when business validation fails."""


class UpstreamServiceError(RepositoryError):
    """Raised when Supabase requests fail."""


@lru_cache(maxsize=8)
def _build_client(supabase_url: str, supabase_key: str) -> Client:
    return create_client(supabase_url, supabase_key)


def get_supabase_client() -> Client:
    resolved_settings = get_settings()
    return _build_client(resolved_settings.supabase_url, resolved_settings.supabase_key)


class SupabaseRepository:
    def __init__(self, client: Client):
        self._client = client

    def _execute(self, query: Any) -> Any:
        try:
            return query.execute()
        except Exception as exc:  # noqa: BLE001
            logger.exception("Supabase query failed")
            raise UpstreamServiceError("Supabase query failed") from exc

    def _execute_mutation(self, query: Any) -> Any:
        try:
            return query.execute()
        except Exception as exc:  # noqa: BLE001
            logger.exception("Supabase mutation failed")
            raise UpstreamServiceError("Supabase mutation failed") from exc

    @staticmethod
    def _first_or_none(data: Any) -> dict[str, Any] | None:
        if not data:
            return None
        if isinstance(data, list):
            return data[0] if data else None
        if isinstance(data, dict):
            return data
        return None

    @staticmethod
    def _as_single_relation(value: Any) -> dict[str, Any] | None:
        if isinstance(value, dict):
            return value
        if isinstance(value, list) and value:
            first = value[0]
            return first if isinstance(first, dict) else None
        return None

    @staticmethod
    def _is_unique_violation(exc: Exception) -> bool:
        message = str(exc).lower()
        return "duplicate key" in message or "unique" in message

    @staticmethod
    def _is_fk_violation(exc: Exception) -> bool:
        return "foreign key" in str(exc).lower()

    def _parse_patient_task_row(self, row: dict[str, Any]) -> PatientTaskResponse:
        raw = dict(row)
        task_definition = self._as_single_relation(raw.get("task_definitions"))
        patient_info = self._as_single_relation(raw.get("patients"))

        task_name = task_definition.get("name") if task_definition else raw.get("task_name")
        if not task_name:
            raise UpstreamServiceError("Missing task definition name in patient task response")

        # Keep only fields expected by PatientTaskResponse.
        payload = {
            "id": raw.get("id"),
            "patient_id": raw.get("patient_id"),
            "patient_external_id": (
                patient_info.get("patient_id") if patient_info else raw.get("patient_external_id")
            ),
            "task_definition_id": raw.get("task_definition_id"),
            "task_name": task_name,
            "status": raw.get("status"),
            "due_at": raw.get("due_at"),
            "created_at": raw.get("created_at"),
            "updated_at": raw.get("updated_at"),
        }

        return PatientTaskResponse.model_validate(payload)

    @staticmethod
    def _parse_patient_row(row: dict[str, Any]) -> PatientResponse:
        payload = {
            "id": row.get("id"),
            "patient_id": row.get("patient_id"),
            "first_name": row.get("first_name"),
            "last_name": row.get("last_name"),
            "description": row.get("description"),
            "admitted_at": row.get("admitted_at"),
            "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at"),
        }
        return PatientResponse.model_validate(payload)

    def _parse_schedule_row(self, row: dict[str, Any]) -> ScheduleItemResponse:
        payload = dict(row)
        patient_info = self._as_single_relation(payload.pop("patients", None))
        payload["patient_external_id"] = (
            patient_info.get("patient_id") if patient_info else payload.get("patient_external_id")
        )
        return ScheduleItemResponse.model_validate(payload)

    @staticmethod
    def _normalize_utc_datetime(value: Any) -> datetime:
        if isinstance(value, datetime):
            dt = value
        elif isinstance(value, str):
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        else:
            raise UpstreamServiceError("Invalid datetime value from schedule row")

        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)

    def _build_planned_schedule_item(
        self,
        row: dict[str, Any],
        reason_by_source_task_id: dict[str, str],
    ) -> PlannedScheduleItem:
        scheduled_for = self._normalize_utc_datetime(row.get("scheduled_for"))
        patient_info = self._as_single_relation(row.get("patients"))

        patient_name = ""
        if patient_info:
            first_name = str(patient_info.get("first_name") or "").strip()
            last_name = str(patient_info.get("last_name") or "").strip()
            patient_name = f"{first_name} {last_name}".strip()
            if not patient_name:
                patient_name = str(patient_info.get("patient_id") or "").strip()

        if not patient_name:
            patient_name = str(row.get("patient_id"))

        source_task_id = row.get("source_patient_task_id")
        reason = "manual"
        if source_task_id is not None:
            reason = reason_by_source_task_id.get(str(source_task_id), "fallback")

        return PlannedScheduleItem(
            schedule_item_id=row["id"],
            task_name=row["task_name"],
            patient_name=patient_name,
            day=scheduled_for.date(),
            hour=scheduled_for.hour,
            priority_score=float(row["score"]),
            reason=reason,
        )

    def _get_schedule_item_by_id(self, schedule_item_id: UUID) -> ScheduleItemResponse:
        response = self._execute(
            self._client.table("schedule_items")
            .select("*, patients(patient_id)")
            .eq("id", str(schedule_item_id))
            .limit(1)
        )
        row = self._first_or_none(response.data)
        if not row:
            raise NotFoundError(f"Schedule item '{schedule_item_id}' not found")
        return self._parse_schedule_row(row)

    def _get_schedule_items_by_ids(self, schedule_item_ids: list[UUID]) -> list[ScheduleItemResponse]:
        if not schedule_item_ids:
            return []

        response = self._execute(
            self._client.table("schedule_items")
            .select("*, patients(patient_id)")
            .in_("id", [str(item_id) for item_id in schedule_item_ids])
        )
        rows = response.data or []
        parsed_items = [self._parse_schedule_row(row) for row in rows]
        by_id = {item.id: item for item in parsed_items}

        missing = [item_id for item_id in schedule_item_ids if item_id not in by_id]
        if missing:
            raise UpstreamServiceError("Some schedule items were not found after insert")

        return [by_id[item_id] for item_id in schedule_item_ids]

    def _get_patient_task_by_pair(
        self,
        patient_internal_id: UUID,
        task_definition_id: UUID,
    ) -> PatientTaskResponse:
        response = self._execute(
            self._client.table("patient_tasks")
            .select("*, task_definitions(id,name), patients(patient_id)")
            .eq("patient_id", str(patient_internal_id))
            .eq("task_definition_id", str(task_definition_id))
            .limit(1)
        )
        row = self._first_or_none(response.data)
        if not row:
            raise NotFoundError("Patient task not found")
        return self._parse_patient_task_row(row)

    def get_patient_by_external_id(self, patient_external_id: int) -> PatientResponse:
        response = self._execute(
            self._client.table("patients").select("*").eq("patient_id", patient_external_id).limit(1)
        )
        patient = self._first_or_none(response.data)
        if not patient:
            raise NotFoundError(f"Patient '{patient_external_id}' not found")
        return self._parse_patient_row(patient)

    def get_patients_by_external_ids(
        self,
        patient_external_ids: list[int],
    ) -> dict[int, PatientResponse]:
        if not patient_external_ids:
            return {}

        response = self._execute(
            self._client.table("patients").select("*").in_("patient_id", patient_external_ids)
        )
        rows = response.data or []
        patients = [self._parse_patient_row(row) for row in rows]
        return {patient.patient_id: patient for patient in patients}

    def list_patients(self) -> list[PatientResponse]:
        response = self._execute(
            self._client.table("patients").select("*").order("created_at", desc=True)
        )
        return [self._parse_patient_row(row) for row in response.data or []]

    def create_patient(self, payload: PatientCreate) -> PatientResponse:
        body = payload.model_dump(mode="json")
        try:
            response = self._client.table("patients").insert(body).execute()
        except Exception as exc:  # noqa: BLE001
            if self._is_unique_violation(exc):
                raise ConflictError(
                    f"Patient with patient_id '{payload.patient_id}' already exists"
                ) from exc
            logger.exception("Failed to create patient")
            raise UpstreamServiceError("Failed to create patient") from exc

        row = self._first_or_none(response.data)
        if not row:
            raise UpstreamServiceError("Failed to create patient")
        return self._parse_patient_row(row)

    def update_patient(self, patient_external_id: int, payload: PatientUpdate) -> PatientResponse:
        body = payload.model_dump(exclude_unset=True, mode="json")
        if not body:
            raise ValidationError("At least one field must be provided")

        self.get_patient_by_external_id(patient_external_id)
        self._execute_mutation(
            self._client.table("patients")
            .update(body)
            .eq("patient_id", patient_external_id)
        )
        return self.get_patient_by_external_id(patient_external_id)

    def delete_patient(self, patient_external_id: int) -> None:
        self.get_patient_by_external_id(patient_external_id)
        self._execute_mutation(
            self._client.table("patients").delete().eq("patient_id", patient_external_id)
        )

    def get_task_definition(self, task_definition_id: UUID) -> TaskDefinitionResponse:
        response = self._execute(
            self._client.table("task_definitions")
            .select("*")
            .eq("id", str(task_definition_id))
            .limit(1)
        )
        row = self._first_or_none(response.data)
        if not row:
            raise NotFoundError(f"Task definition '{task_definition_id}' not found")
        return TaskDefinitionResponse.model_validate(row)

    def list_task_definitions(self) -> list[TaskDefinitionResponse]:
        response = self._execute(
            self._client.table("task_definitions").select("*").order("name", desc=False)
        )
        return [TaskDefinitionResponse.model_validate(row) for row in response.data or []]

    def create_task_definition(self, payload: TaskDefinitionCreate) -> TaskDefinitionResponse:
        body = payload.model_dump(mode="json")
        try:
            response = self._client.table("task_definitions").insert(body).execute()
        except Exception as exc:  # noqa: BLE001
            if self._is_unique_violation(exc):
                raise ConflictError(f"Task definition '{payload.name}' already exists") from exc
            logger.exception("Failed to create task definition")
            raise UpstreamServiceError("Failed to create task definition") from exc

        row = self._first_or_none(response.data)
        if row:
            return TaskDefinitionResponse.model_validate(row)

        lookup = self._execute(
            self._client.table("task_definitions")
            .select("*")
            .ilike("name", payload.name)
            .limit(1)
        )
        fallback_row = self._first_or_none(lookup.data)
        if not fallback_row:
            raise UpstreamServiceError("Failed to create task definition")
        return TaskDefinitionResponse.model_validate(fallback_row)

    def update_task_definition(
        self,
        task_definition_id: UUID,
        payload: TaskDefinitionUpdate,
    ) -> TaskDefinitionResponse:
        body = payload.model_dump(exclude_unset=True, mode="json")
        if not body:
            raise ValidationError("At least one field must be provided")

        self.get_task_definition(task_definition_id)
        try:
            self._client.table("task_definitions").update(body).eq(
                "id", str(task_definition_id)
            ).execute()
        except Exception as exc:  # noqa: BLE001
            if self._is_unique_violation(exc):
                raise ConflictError(f"Task definition '{payload.name}' already exists") from exc
            logger.exception("Failed to update task definition")
            raise UpstreamServiceError("Failed to update task definition") from exc

        return self.get_task_definition(task_definition_id)

    def delete_task_definition(self, task_definition_id: UUID) -> None:
        self.get_task_definition(task_definition_id)
        try:
            self._client.table("task_definitions").delete().eq("id", str(task_definition_id)).execute()
        except Exception as exc:  # noqa: BLE001
            if self._is_fk_violation(exc):
                raise ConflictError(
                    f"Task definition '{task_definition_id}' is in use and cannot be deleted"
                ) from exc
            logger.exception("Failed to delete task definition")
            raise UpstreamServiceError("Failed to delete task definition") from exc

    def get_patient_task(self, patient_task_id: UUID) -> PatientTaskResponse:
        response = self._execute(
            self._client.table("patient_tasks")
            .select("*, task_definitions(id,name), patients(patient_id)")
            .eq("id", str(patient_task_id))
            .limit(1)
        )
        row = self._first_or_none(response.data)
        if not row:
            raise NotFoundError(f"Patient task '{patient_task_id}' not found")
        return self._parse_patient_task_row(row)

    def create_patient_task(
        self,
        patient_external_id: int,
        payload: PatientTaskAssignCreate,
    ) -> PatientTaskResponse:
        patient = self.get_patient_by_external_id(patient_external_id)
        self.get_task_definition(payload.task_definition_id)

        body = payload.model_dump(mode="json")
        body["patient_id"] = str(patient.id)

        try:
            response = self._client.table("patient_tasks").insert(body).execute()
        except Exception as exc:  # noqa: BLE001
            if self._is_unique_violation(exc):
                raise ConflictError("Task already assigned to this patient") from exc
            if self._is_fk_violation(exc):
                raise NotFoundError("Task definition not found") from exc
            logger.exception("Failed to create patient task")
            raise UpstreamServiceError("Failed to create patient task") from exc

        row = self._first_or_none(response.data)
        if row and row.get("id"):
            created = self.get_patient_task(UUID(str(row["id"])))
        else:
            created = self._get_patient_task_by_pair(
                patient_internal_id=patient.id,
                task_definition_id=payload.task_definition_id,
            )

        return created.model_copy(update={"patient_external_id": patient.patient_id})

    def list_patient_tasks(
        self,
        patient_external_id: int,
        status: TaskStatus | None = TaskStatus.pending,
    ) -> list[PatientTaskResponse]:
        patient = self.get_patient_by_external_id(patient_external_id)

        query = (
            self._client.table("patient_tasks")
            .select("*, task_definitions(id,name), patients(patient_id)")
            .eq("patient_id", str(patient.id))
            .order("created_at", desc=True)
        )
        if status is not None:
            query = query.eq("status", status.value)

        response = self._execute(query)
        return [
            self._parse_patient_task_row(row).model_copy(update={"patient_external_id": patient.patient_id})
            for row in (response.data or [])
        ]

    def update_patient_task(self, patient_task_id: UUID, payload: PatientTaskUpdate) -> PatientTaskResponse:
        body = payload.model_dump(exclude_unset=True, mode="json")
        if not body:
            raise ValidationError("At least one field must be provided")

        self.get_patient_task(patient_task_id)
        self._execute_mutation(
            self._client.table("patient_tasks")
            .update(body)
            .eq("id", str(patient_task_id))
        )
        return self.get_patient_task(patient_task_id)

    def list_pending_tasks_for_patient_internal_ids(
        self,
        patient_internal_ids: list[UUID],
    ) -> dict[str, list[PlannerTaskContext]]:
        if not patient_internal_ids:
            return {}

        ids = [str(patient_id) for patient_id in patient_internal_ids]
        response = self._execute(
            self._client.table("patient_tasks")
            .select(
                "id, patient_id, task_definition_id, due_at, status, "
                "llm_priority, llm_confidence, llm_reason, llm_context_hash, llm_scored_at, "
                "task_definitions(name)"
            )
            .in_("patient_id", ids)
            .eq("status", TaskStatus.pending.value)
            .order("created_at", desc=False)
        )

        grouped: dict[str, list[PlannerTaskContext]] = {}
        for row in response.data or []:
            task_definition = self._as_single_relation(row.get("task_definitions"))
            task_name = task_definition.get("name") if task_definition else None
            if not task_name:
                raise UpstreamServiceError("Missing task definition name for planner context")

            task = PlannerTaskContext.model_validate(
                {
                    "id": row["id"],
                    "task_definition_id": row["task_definition_id"],
                    "task_name": task_name,
                    "status": row["status"],
                    "due_at": row.get("due_at"),
                    "llm_priority": row.get("llm_priority"),
                    "llm_confidence": row.get("llm_confidence"),
                    "llm_reason": row.get("llm_reason"),
                    "llm_context_hash": row.get("llm_context_hash"),
                    "llm_scored_at": row.get("llm_scored_at"),
                }
            )
            grouped.setdefault(str(row["patient_id"]), []).append(task)

        return grouped

    def update_patient_task_llm_cache(self, payload: PlannerLlmCacheUpdate) -> None:
        body = payload.model_dump(mode="json", exclude={"patient_task_id"})
        self._execute_mutation(
            self._client.table("patient_tasks")
            .update(body)
            .eq("id", str(payload.patient_task_id))
        )

    def cancel_patient_task(self, patient_task_id: UUID) -> None:
        self.get_patient_task(patient_task_id)
        self._execute_mutation(
            self._client.table("patient_tasks")
            .update({"status": TaskStatus.cancelled.value})
            .eq("id", str(patient_task_id))
        )

    def create_schedule_item(self, payload: dict[str, Any]) -> ScheduleItemResponse:
        response = self._execute_mutation(
            self._client.table("schedule_items").insert(payload)
        )
        row = self._first_or_none(response.data)
        if not row or not row.get("id"):
            raise UpstreamServiceError("Failed to create schedule item")
        return self._get_schedule_item_by_id(UUID(str(row["id"])))

    def bulk_create_schedule_items(self, payload: list[dict[str, Any]]) -> list[ScheduleItemResponse]:
        if not payload:
            return []

        response = self._execute_mutation(
            self._client.table("schedule_items").insert(payload)
        )
        rows = response.data or []
        schedule_item_ids: list[UUID] = []
        for row in rows:
            item_id = row.get("id") if isinstance(row, dict) else None
            if item_id is None:
                continue
            schedule_item_ids.append(UUID(str(item_id)))

        if len(schedule_item_ids) != len(payload):
            raise UpstreamServiceError("Failed to create all schedule items")

        return self._get_schedule_items_by_ids(schedule_item_ids)

    def list_schedule_items(self) -> list[ScheduleItemResponse]:
        response = self._execute(
            self._client.table("schedule_items")
            .select("*, patients(patient_id)")
            .order("scheduled_for", desc=False)
        )
        return [self._parse_schedule_row(row) for row in response.data or []]

    def list_schedule_items_from(self, from_utc: datetime) -> list[ScheduleItemResponse]:
        response = self._execute(
            self._client.table("schedule_items")
            .select("*, patients(patient_id)")
            .gte("scheduled_for", from_utc.isoformat())
            .order("scheduled_for", desc=False)
        )
        return [self._parse_schedule_row(row) for row in response.data or []]

    def list_schedule_items_by_source_task_ids(
        self,
        source_task_ids: list[UUID],
    ) -> list[ScheduleItemResponse]:
        if not source_task_ids:
            return []

        response = self._execute(
            self._client.table("schedule_items")
            .select("*, patients(patient_id)")
            .in_("source_patient_task_id", [str(task_id) for task_id in source_task_ids])
        )
        return [self._parse_schedule_row(row) for row in response.data or []]

    def list_schedule_items_for_day(self, schedule_day: date) -> list[ScheduleItemResponse]:
        day_start = datetime.combine(schedule_day, datetime.min.time(), tzinfo=timezone.utc)
        day_end = day_start + timedelta(days=1)
        response = self._execute(
            self._client.table("schedule_items")
            .select("*, patients(patient_id)")
            .gte("scheduled_for", day_start.isoformat())
            .lt("scheduled_for", day_end.isoformat())
            .order("scheduled_for", desc=False)
        )
        return [self._parse_schedule_row(row) for row in response.data or []]

    def _get_reason_map_for_source_tasks(
        self,
        source_task_ids: list[str],
    ) -> dict[str, str]:
        if not source_task_ids:
            return {}

        response = self._execute(
            self._client.table("patient_tasks")
            .select("id,llm_reason")
            .in_("id", source_task_ids)
        )
        reason_map: dict[str, str] = {}
        for row in response.data or []:
            row_id = row.get("id")
            if row_id is None:
                continue
            reason = str(row.get("llm_reason") or "").strip() or "fallback"
            reason_map[str(row_id)] = reason
        return reason_map

    def list_schedule_plan_items(
        self,
        patient_external_id: int | None = None,
        schedule_day: date | None = None,
    ) -> list[PlannedScheduleItem]:
        patient_internal_id: str | None = None
        if patient_external_id is not None:
            patient = self.get_patient_by_external_id(patient_external_id)
            patient_internal_id = str(patient.id)

        query = (
            self._client.table("schedule_items")
            .select("id,patient_id,source_patient_task_id,task_name,scheduled_for,score,patients(patient_id,first_name,last_name)")
            .order("scheduled_for", desc=False)
        )
        if patient_internal_id is not None:
            query = query.eq("patient_id", patient_internal_id)
        if schedule_day is not None:
            day_start = datetime.combine(schedule_day, datetime.min.time(), tzinfo=timezone.utc)
            day_end = day_start + timedelta(days=1)
            query = query.gte("scheduled_for", day_start.isoformat()).lt("scheduled_for", day_end.isoformat())

        response = self._execute(query)
        rows = response.data or []
        source_task_ids = [
            str(row.get("source_patient_task_id"))
            for row in rows
            if row.get("source_patient_task_id") is not None
        ]
        reason_map = self._get_reason_map_for_source_tasks(source_task_ids)

        return [self._build_planned_schedule_item(row, reason_map) for row in rows]

    def delete_schedule_item(self, schedule_item_id: UUID) -> None:
        self._get_schedule_item_by_id(schedule_item_id)
        self._execute_mutation(
            self._client.table("schedule_items")
            .delete()
            .eq("id", str(schedule_item_id))
        )

    def delete_schedule_items(self, schedule_item_ids: list[UUID]) -> None:
        if not schedule_item_ids:
            return
        self._execute_mutation(
            self._client.table("schedule_items")
            .delete()
            .in_("id", [str(item_id) for item_id in schedule_item_ids])
        )

    def update_schedule_item(
        self,
        schedule_item_id: UUID,
        payload: dict[str, Any],
    ) -> ScheduleItemResponse:
        if not payload:
            return self._get_schedule_item_by_id(schedule_item_id)

        try:
            self._client.table("schedule_items").update(payload).eq("id", str(schedule_item_id)).execute()
        except Exception as exc:  # noqa: BLE001
            if self._is_unique_violation(exc):
                raise ConflictError("Schedule conflict while updating item") from exc
            logger.exception("Failed to update schedule item")
            raise UpstreamServiceError("Failed to update schedule item") from exc

        return self._get_schedule_item_by_id(schedule_item_id)

    def get_schedule_item(self, schedule_item_id: UUID) -> ScheduleItemResponse:
        return self._get_schedule_item_by_id(schedule_item_id)


def get_repository() -> SupabaseRepository:
    return SupabaseRepository(get_supabase_client())
