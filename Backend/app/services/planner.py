from __future__ import annotations

import hashlib
import logging
from datetime import date, datetime, time, timedelta, timezone
from typing import Callable
from uuid import UUID

from app.db.supabase_client import SupabaseRepository
from app.llm.openai_client import OpenAIPlannerClient
from app.models.schemas import (
    PlannerLlmCacheUpdate,
    PlannerPatientContext,
    SchedulePlanResponse,
    ScheduleSyncResult,
)

logger = logging.getLogger(__name__)


class PlannerValidationError(Exception):
    """Raised when planner input cannot be satisfied."""


class PlannerService:
    START_HOUR = 9
    END_HOUR = 21
    MAX_LOOKAHEAD_DAYS = 30

    def __init__(
        self,
        repository: SupabaseRepository,
        llm_client: OpenAIPlannerClient,
        now_provider: Callable[[], datetime] | None = None,
    ):
        self._repository = repository
        self._llm_client = llm_client
        self._now_provider = now_provider or (lambda: datetime.now(tz=timezone.utc))

    @staticmethod
    def _to_utc(value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    def calculate_waiting_minutes(self, admitted_at: datetime | None, now_utc: datetime | None = None) -> float:
        reference_time = now_utc or self._now_provider()
        normalized_admitted = self._to_utc(admitted_at)
        if normalized_admitted is None:
            return 0.0
        waiting_seconds = max(0.0, (reference_time - normalized_admitted).total_seconds())
        return waiting_seconds / 60.0

    def calculate_score(
        self,
        priority: int,
        admitted_at: datetime | None,
        now_utc: datetime | None = None,
    ) -> tuple[float, float]:
        waiting_minutes = self.calculate_waiting_minutes(admitted_at=admitted_at, now_utc=now_utc)
        score = float(priority) * 10 + waiting_minutes * 0.05
        return waiting_minutes, score

    def _clamp_hour(self, hour: int) -> int:
        return max(self.START_HOUR, min(self.END_HOUR, hour))

    def _schedule_datetime(self, schedule_date: date, hour: int) -> datetime:
        return datetime.combine(schedule_date, time(hour=hour, minute=0, tzinfo=timezone.utc))

    def _planning_anchor(self, now_utc: datetime) -> datetime:
        if now_utc.tzinfo is None:
            now_utc = now_utc.replace(tzinfo=timezone.utc)
        else:
            now_utc = now_utc.astimezone(timezone.utc)

        # Planning must always start from 09:00 and move forward hour by hour.
        if now_utc.hour > self.END_HOUR:
            return (now_utc + timedelta(days=1)).replace(
                hour=self.START_HOUR, minute=0, second=0, microsecond=0
            )
        return now_utc.replace(hour=self.START_HOUR, minute=0, second=0, microsecond=0)

    def _build_context_hash(
        self,
        patient_description: str,
        task_name: str,
        status: str,
        due_at: datetime | None,
        admitted_at: datetime | None,
    ) -> str:
        normalized_due = self._to_utc(due_at).isoformat() if due_at else "-"
        normalized_admitted = self._to_utc(admitted_at).isoformat() if admitted_at else "-"
        raw = "|".join(
            [
                patient_description.strip(),
                task_name.strip(),
                status,
                normalized_due,
                normalized_admitted,
            ]
        )
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def _build_contexts(self) -> dict[int, PlannerPatientContext]:
        patients = self._repository.list_patients()
        if not patients:
            return {}

        pending_tasks_by_patient = self._repository.list_pending_tasks_for_patient_internal_ids(
            [patient.id for patient in patients]
        )

        contexts: dict[int, PlannerPatientContext] = {}
        for patient in patients:
            tasks = pending_tasks_by_patient.get(str(patient.id), [])
            if not tasks:
                continue

            patient_name = f"{patient.first_name} {patient.last_name}".strip() or patient.patient_id
            contexts[patient.patient_id] = PlannerPatientContext(
                patient_uuid=patient.id,
                patient_external_id=patient.patient_id,
                patient_name=patient_name,
                description=patient.description,
                admitted_at=self._to_utc(patient.admitted_at),
                tasks=tasks,
            )

        return contexts

    def _resolve_llm_priority(
        self,
        context: PlannerPatientContext,
        task_name: str,
        cached_priority: int | None,
        cached_confidence: float | None,
        cached_reason: str | None,
        cached_context_hash: str | None,
        expected_context_hash: str,
        task_id: UUID,
        now_utc: datetime,
        pending_cache_updates: list[PlannerLlmCacheUpdate],
    ) -> tuple[int, float, str]:
        if (
            cached_context_hash == expected_context_hash
            and cached_priority is not None
            and cached_reason is not None
        ):
            return cached_priority, float(cached_confidence or 0.0), cached_reason

        llm_result = self._llm_client.estimate_priority(
            patient_description=context.description,
            task_title=task_name,
            task_details=None,
        )
        pending_cache_updates.append(
            PlannerLlmCacheUpdate(
                patient_task_id=task_id,
                llm_priority=llm_result.priority,
                llm_confidence=llm_result.confidence,
                llm_reason=llm_result.reason,
                llm_context_hash=expected_context_hash,
                llm_scored_at=now_utc,
            )
        )
        return llm_result.priority, llm_result.confidence, llm_result.reason

    @staticmethod
    def _rows_are_equal(existing_row: dict[str, object], desired_row: dict[str, object]) -> bool:
        same_schedule = existing_row["scheduled_for"] == desired_row["scheduled_for"]
        same_score = round(float(existing_row["score"]), 6) == round(float(desired_row["score"]), 6)
        return (
            existing_row["patient_id"] == desired_row["patient_id"]
            and existing_row["task_definition_id"] == desired_row["task_definition_id"]
            and existing_row["task_name"] == desired_row["task_name"]
            and same_schedule
            and int(existing_row["priority"]) == int(desired_row["priority"])
            and same_score
        )

    def _sync_schedule(
        self,
        desired_rows: list[dict[str, object]],
        planning_anchor: datetime,
    ) -> ScheduleSyncResult:
        existing_future = self._repository.list_schedule_items_from(planning_anchor)
        existing_by_source: dict[UUID, dict[str, object]] = {}
        for item in existing_future:
            if item.source_patient_task_id is None:
                continue
            existing_by_source[item.source_patient_task_id] = {
                "id": item.id,
                "patient_id": item.patient_id,
                "task_definition_id": item.task_definition_id,
                "task_name": item.task_name,
                "scheduled_for": self._to_utc(item.scheduled_for).isoformat(),
                "priority": item.priority,
                "score": item.score,
            }

        desired_by_source: dict[UUID, dict[str, object]] = {
            row["source_patient_task_id"]: row for row in desired_rows
        }

        unchanged_sources: set[UUID] = set()
        changed_sources: set[UUID] = set()
        for source_task_id, desired in desired_by_source.items():
            existing = existing_by_source.get(source_task_id)
            if existing is None:
                continue
            if self._rows_are_equal(existing, desired):
                unchanged_sources.add(source_task_id)
            else:
                changed_sources.add(source_task_id)

        stale_sources = set(existing_by_source) - set(desired_by_source)
        delete_ids = [
            UUID(str(existing_by_source[source_task_id]["id"]))
            for source_task_id in (changed_sources | stale_sources)
        ]

        insert_payload = [
            {
                "patient_id": str(row["patient_id"]),
                "task_definition_id": str(row["task_definition_id"]),
                "source_patient_task_id": str(row["source_patient_task_id"]),
                "task_name": row["task_name"],
                "scheduled_for": row["scheduled_for"],
                "priority": row["priority"],
                "score": row["score"],
            }
            for source_task_id, row in desired_by_source.items()
            if source_task_id not in unchanged_sources
        ]

        if delete_ids:
            self._repository.delete_schedule_items(delete_ids)
        if insert_payload:
            self._repository.bulk_create_schedule_items(insert_payload)

        return ScheduleSyncResult(
            inserted=len(insert_payload),
            updated=len(changed_sources),
            deleted=len(delete_ids),
        )

    def _allocate_slot(
        self,
        patient_uuid: UUID,
        task_definition_id: UUID,
        preferred_date: date,
        preferred_hour: int,
        patient_busy: set[tuple[UUID, date, int]],
        task_busy: set[tuple[UUID, date, int]],
    ) -> tuple[date, int]:
        for day_offset in range(self.MAX_LOOKAHEAD_DAYS + 1):
            current_date = preferred_date + timedelta(days=day_offset)
            hours = list(range(self.START_HOUR, self.END_HOUR + 1))

            for hour in hours:
                patient_key = (patient_uuid, current_date, hour)
                task_key = (task_definition_id, current_date, hour)
                if patient_key in patient_busy:
                    continue
                if task_key in task_busy:
                    continue

                patient_busy.add(patient_key)
                task_busy.add(task_key)
                return current_date, hour

        raise PlannerValidationError(
            "No available slot found within lookahead window for scheduling constraints"
        )

    def replan_and_sync(self) -> SchedulePlanResponse:
        now_utc = self._now_provider()
        planning_anchor = self._planning_anchor(now_utc)
        contexts = self._build_contexts()
        pending_cache_updates: list[PlannerLlmCacheUpdate] = []

        candidate_items: list[dict[str, object]] = []
        for patient_external_id in sorted(contexts):
            context = contexts[patient_external_id]
            for task in context.tasks:
                context_hash = self._build_context_hash(
                    patient_description=context.description,
                    task_name=task.task_name,
                    status=task.status.value,
                    due_at=task.due_at,
                    admitted_at=context.admitted_at,
                )
                priority, _, reason = self._resolve_llm_priority(
                    context=context,
                    task_name=task.task_name,
                    cached_priority=task.llm_priority,
                    cached_confidence=task.llm_confidence,
                    cached_reason=task.llm_reason,
                    cached_context_hash=task.llm_context_hash,
                    expected_context_hash=context_hash,
                    task_id=task.id,
                    now_utc=now_utc,
                    pending_cache_updates=pending_cache_updates,
                )
                _, score = self.calculate_score(
                    priority=priority,
                    admitted_at=context.admitted_at,
                    now_utc=now_utc,
                )
                candidate_items.append(
                    {
                        "patient_uuid": context.patient_uuid,
                        "patient_external_id": context.patient_external_id,
                        "patient_name": context.patient_name,
                        "task_definition_id": task.task_definition_id,
                        "task_name": task.task_name,
                        "source_patient_task_id": task.id,
                        "preferred_date": planning_anchor.date(),
                        "preferred_hour": planning_anchor.hour,
                        "priority": priority,
                        "priority_score": score,
                        "reason": reason,
                    }
                )

        candidate_items.sort(
            key=lambda item: (
                -float(item["priority_score"]),
                str(item["patient_external_id"]),
                str(item["task_name"]),
            )
        )

        patient_busy: set[tuple[UUID, date, int]] = set()
        task_busy: set[tuple[UUID, date, int]] = set()

        existing_items = self._repository.list_schedule_items_from(planning_anchor)
        for item in existing_items:
            if item.source_patient_task_id is not None:
                continue
            schedule_dt = self._to_utc(item.scheduled_for)
            if schedule_dt is None:
                continue
            schedule_hour = schedule_dt.hour
            if schedule_hour < self.START_HOUR or schedule_hour > self.END_HOUR:
                continue
            schedule_date = schedule_dt.date()
            patient_busy.add((item.patient_id, schedule_date, schedule_hour))
            if item.task_definition_id is not None:
                task_busy.add((item.task_definition_id, schedule_date, schedule_hour))

        planned_rows: list[dict[str, object]] = []
        for item in candidate_items:
            allocated_date, allocated_hour = self._allocate_slot(
                patient_uuid=item["patient_uuid"],
                task_definition_id=item["task_definition_id"],
                preferred_date=item["preferred_date"],
                preferred_hour=item["preferred_hour"],
                patient_busy=patient_busy,
                task_busy=task_busy,
            )
            scheduled_for = self._schedule_datetime(allocated_date, allocated_hour)
            planned_rows.append(
                {
                    **item,
                    "scheduled_for": scheduled_for,
                    "hour": allocated_hour,
                }
            )

        for cache_update in pending_cache_updates:
            self._repository.update_patient_task_llm_cache(cache_update)

        desired_rows = [
            {
                "patient_id": item["patient_uuid"],
                "task_definition_id": item["task_definition_id"],
                "source_patient_task_id": item["source_patient_task_id"],
                "task_name": str(item["task_name"]),
                "scheduled_for": item["scheduled_for"].isoformat(),
                "priority": int(item["priority"]),
                "score": float(item["priority_score"]),
            }
            for item in planned_rows
        ]
        sync_result = self._sync_schedule(desired_rows=desired_rows, planning_anchor=planning_anchor)
        logger.info(
            "Scheduler sync completed inserted=%s updated=%s deleted=%s cache_updates=%s",
            sync_result.inserted,
            sync_result.updated,
            sync_result.deleted,
            len(pending_cache_updates),
        )

        return SchedulePlanResponse(items=self._repository.list_schedule_plan_items())

    def plan_schedule(self) -> SchedulePlanResponse:
        return self.replan_and_sync()
