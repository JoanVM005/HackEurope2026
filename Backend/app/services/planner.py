from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Callable
from uuid import UUID

from app.db.supabase_client import SupabaseRepository
from app.llm.openai_client import OpenAIPlannerClient
from app.models.preferences import (
    AppliedPreferencesSummary,
    MatchType,
    PlannerPreferences,
    PriorityOverrideRule,
    TimeBlock,
)
from app.models.schemas import (
    PlannerLlmCacheUpdate,
    PlannerPatientContext,
    SchedulePlanResponse,
    ScheduleSyncResult,
)
from app.services.preferences_service import PreferencesService

logger = logging.getLogger(__name__)


class PlannerValidationError(Exception):
    """Raised when planner input cannot be satisfied."""


@dataclass(frozen=True)
class PatientTimePreferenceProfile:
    preferred_ranges: tuple[tuple[int, int], ...] = ()
    avoid_ranges: tuple[tuple[int, int], ...] = ()
    ignored_tokens: int = 0

    @property
    def has_bias(self) -> bool:
        return bool(self.preferred_ranges or self.avoid_ranges)


class PlannerService:
    START_HOUR = 9
    END_HOUR = 21
    MAX_LOOKAHEAD_DAYS = 30
    TIME_WINDOW_PATTERN = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)$")
    PREFERRED_KEYS = {
        "",
        "pref_time",
        "prefer_time",
        "preferred_time",
        "time_pref",
        "preference",
        "preferred",
    }
    AVOID_KEYS = {"avoid", "avoid_time", "avoid_times", "blocked", "block"}
    NAMED_TIME_WINDOWS: dict[str, tuple[tuple[int, int], ...]] = {
        "morning": ((9 * 60, 12 * 60),),
        "midday": ((12 * 60, 15 * 60),),
        "afternoon": ((15 * 60, 18 * 60),),
        "evening": ((18 * 60, 21 * 60),),
        "late_evening": ((20 * 60, 21 * 60),),
    }

    def __init__(
        self,
        repository: SupabaseRepository,
        llm_client: OpenAIPlannerClient,
        preferences_service: PreferencesService,
        now_provider: Callable[[], datetime] | None = None,
    ):
        self._repository = repository
        self._llm_client = llm_client
        self._preferences_service = preferences_service
        self._now_provider = now_provider or (lambda: datetime.now(tz=timezone.utc))

    @staticmethod
    def _to_utc(value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    @staticmethod
    def _clock_to_minutes(value: str) -> int:
        hour_text, minute_text = value.split(":", 1)
        return int(hour_text) * 60 + int(minute_text)

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
        w_priority: float = 10.0,
        w_wait: float = 0.05,
    ) -> tuple[float, float]:
        waiting_minutes = self.calculate_waiting_minutes(admitted_at=admitted_at, now_utc=now_utc)
        score = float(priority) * w_priority + waiting_minutes * w_wait
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

        if now_utc.hour > self.END_HOUR:
            return (now_utc + timedelta(days=1)).replace(
                hour=self.START_HOUR, minute=0, second=0, microsecond=0
            )
        return now_utc.replace(hour=self.START_HOUR, minute=0, second=0, microsecond=0)

    def _build_context_hash(
        self,
        patient_description: str,
        time_preferences: str | None,
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
                (time_preferences or "").strip(),
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
                time_preferences=patient.time_preferences,
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
            task_details=(
                json.dumps(
                    {"time_preferences": context.time_preferences},
                    separators=(",", ":"),
                    sort_keys=True,
                )
                if context.time_preferences
                else None
            ),
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
        delete_ids_set = set(delete_ids)

        sources_to_insert = [
            source_task_id for source_task_id in desired_by_source if source_task_id not in unchanged_sources
        ]
        if sources_to_insert:
            historical_conflicts = self._repository.list_schedule_items_by_source_task_ids(sources_to_insert)
            for conflict_item in historical_conflicts:
                delete_ids_set.add(conflict_item.id)
        delete_ids = list(delete_ids_set)

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

    def _is_hour_blocked(self, hour: int, time_blocks: list[TimeBlock]) -> bool:
        slot_minutes = hour * 60
        for block in time_blocks:
            start_minutes = self._clock_to_minutes(block.start)
            end_minutes = self._clock_to_minutes(block.end)
            if start_minutes <= slot_minutes < end_minutes:
                return True
        return False

    def _apply_priority_overrides(
        self,
        patient_description: str,
        llm_priority: int,
        rules: list[PriorityOverrideRule],
        warnings: set[str],
    ) -> tuple[int, bool]:
        max_override = llm_priority
        description_ci = patient_description.lower()

        for rule in rules:
            if not rule.enabled:
                continue

            matched = False
            if rule.match_type == MatchType.contains:
                matched = rule.pattern.lower() in description_ci
            elif rule.match_type == MatchType.regex:
                try:
                    matched = re.search(rule.pattern, patient_description, flags=re.IGNORECASE) is not None
                except re.error:
                    warnings.add(f"invalid_regex_ignored:{rule.pattern}")
                    continue

            if matched:
                max_override = max(max_override, int(rule.priority))

        final_priority = max(1, min(5, max_override))
        return final_priority, final_priority != llm_priority

    def _parse_time_window(self, token: str) -> tuple[int, int] | None:
        match = self.TIME_WINDOW_PATTERN.fullmatch(token)
        if not match:
            return None
        start_hour, start_minute, end_hour, end_minute = match.groups()
        start_minutes = int(start_hour) * 60 + int(start_minute)
        end_minutes = int(end_hour) * 60 + int(end_minute)
        if start_minutes >= end_minutes:
            return None
        return start_minutes, end_minutes

    def _decode_time_preference_token(
        self,
        token: str,
    ) -> tuple[tuple[tuple[int, int], ...] | None, bool]:
        cleaned = token.strip().lower()
        if not cleaned:
            return None, False

        parsed_window = self._parse_time_window(cleaned)
        if parsed_window is not None:
            return (parsed_window,), False

        normalized = re.sub(r"\s+", "_", cleaned).replace("-", "_")
        if normalized == "flexible":
            return None, True
        if normalized in self.NAMED_TIME_WINDOWS:
            return self.NAMED_TIME_WINDOWS[normalized], False

        return None, False

    def _parse_patient_time_preferences(self, raw_preferences: str | None) -> PatientTimePreferenceProfile:
        if raw_preferences is None:
            return PatientTimePreferenceProfile()

        cleaned_preferences = raw_preferences.strip()
        if not cleaned_preferences:
            return PatientTimePreferenceProfile()

        preferred_ranges: list[tuple[int, int]] = []
        avoid_ranges: list[tuple[int, int]] = []
        ignored_tokens = 0

        segments = [segment.strip() for segment in cleaned_preferences.split(";") if segment.strip()]
        if not segments:
            segments = [cleaned_preferences]

        for segment in segments:
            key = ""
            raw_values = segment
            if "=" in segment:
                key_part, raw_values = segment.split("=", 1)
                key = key_part.strip().lower()

            tokens = [token.strip() for token in re.split(r"[,\|]", raw_values) if token.strip()]
            if not tokens:
                continue

            if key in self.PREFERRED_KEYS:
                target = "preferred"
            elif key in self.AVOID_KEYS:
                target = "avoid"
            else:
                ignored_tokens += len(tokens)
                continue

            for token in tokens:
                decoded_ranges, is_flexible = self._decode_time_preference_token(token)
                if is_flexible and target == "preferred":
                    preferred_ranges.clear()
                    continue
                if decoded_ranges is None:
                    ignored_tokens += 1
                    continue
                if target == "preferred":
                    preferred_ranges.extend(decoded_ranges)
                else:
                    avoid_ranges.extend(decoded_ranges)

        return PatientTimePreferenceProfile(
            preferred_ranges=tuple(preferred_ranges),
            avoid_ranges=tuple(avoid_ranges),
            ignored_tokens=ignored_tokens,
        )

    def _profile_from_llm_normalization(self, normalization: object) -> PatientTimePreferenceProfile:
        preferred_ranges: list[tuple[int, int]] = []
        avoid_ranges: list[tuple[int, int]] = []

        preferred_windows = getattr(normalization, "preferred_windows", [])
        avoid_windows = getattr(normalization, "avoid_windows", [])

        for window in preferred_windows:
            start = getattr(window, "start", None)
            end = getattr(window, "end", None)
            if not isinstance(start, str) or not isinstance(end, str):
                continue
            parsed = self._parse_time_window(f"{start}-{end}")
            if parsed is not None:
                preferred_ranges.append(parsed)

        for window in avoid_windows:
            start = getattr(window, "start", None)
            end = getattr(window, "end", None)
            if not isinstance(start, str) or not isinstance(end, str):
                continue
            parsed = self._parse_time_window(f"{start}-{end}")
            if parsed is not None:
                avoid_ranges.append(parsed)

        return PatientTimePreferenceProfile(
            preferred_ranges=tuple(preferred_ranges),
            avoid_ranges=tuple(avoid_ranges),
            ignored_tokens=0,
        )

    def _resolve_patient_time_preferences(
        self,
        raw_preferences: str | None,
        warnings: set[str],
    ) -> tuple[PatientTimePreferenceProfile, bool]:
        deterministic_profile = self._parse_patient_time_preferences(raw_preferences)
        cleaned = (raw_preferences or "").strip()
        if not cleaned:
            return deterministic_profile, False
        if deterministic_profile.has_bias:
            return deterministic_profile, False

        llm_normalized = self._llm_client.normalize_time_preferences(cleaned)
        if llm_normalized is None:
            if deterministic_profile.ignored_tokens > 0:
                warnings.add("time_pref_llm_normalization_unavailable")
            return deterministic_profile, False

        llm_profile = self._profile_from_llm_normalization(llm_normalized)
        if llm_profile.has_bias:
            return llm_profile, True

        if deterministic_profile.ignored_tokens > 0:
            warnings.add("time_pref_llm_no_match")
        return deterministic_profile, False

    @staticmethod
    def _minute_is_in_ranges(minute_of_day: int, ranges: tuple[tuple[int, int], ...]) -> bool:
        return any(start <= minute_of_day < end for start, end in ranges)

    def _time_preference_penalty(self, hour: int, profile: PatientTimePreferenceProfile) -> float:
        slot_minutes = hour * 60
        if profile.avoid_ranges and self._minute_is_in_ranges(slot_minutes, profile.avoid_ranges):
            return 2.0
        if profile.preferred_ranges and self._minute_is_in_ranges(slot_minutes, profile.preferred_ranges):
            return 0.0
        return 1.0

    def _allocate_slot(
        self,
        patient_uuid: UUID,
        task_definition_id: UUID,
        preferred_date: date,
        preferred_hour: int,
        patient_busy: set[tuple[UUID, date, int]],
        task_busy: set[tuple[UUID, date, int]],
        time_blocks: list[TimeBlock],
        time_preference_profile: PatientTimePreferenceProfile,
        w_time_pref: float,
    ) -> tuple[date, int, bool, bool]:
        use_time_preference_bias = w_time_pref > 0 and time_preference_profile.has_bias
        best_candidate: tuple[float, int, int, date, int] | None = None
        blocked_orders: list[tuple[int, int]] = []

        for day_offset in range(self.MAX_LOOKAHEAD_DAYS + 1):
            current_date = preferred_date + timedelta(days=day_offset)
            if day_offset == 0:
                start_hour = self._clamp_hour(preferred_hour)
                hours = list(range(start_hour, self.END_HOUR + 1))
                if start_hour > self.START_HOUR:
                    hours.extend(range(self.START_HOUR, start_hour))
            else:
                hours = list(range(self.START_HOUR, self.END_HOUR + 1))

            for hour_index, hour in enumerate(hours):
                if self._is_hour_blocked(hour, time_blocks):
                    blocked_orders.append((day_offset, hour_index))
                    continue

                patient_key = (patient_uuid, current_date, hour)
                task_key = (task_definition_id, current_date, hour)
                if patient_key in patient_busy:
                    continue
                if task_key in task_busy:
                    continue

                slot_cost = float(day_offset * 100 + hour_index)
                if use_time_preference_bias:
                    pref_penalty = self._time_preference_penalty(hour, time_preference_profile)
                    slot_cost += w_time_pref * 10.0 * pref_penalty

                candidate = (slot_cost, day_offset, hour_index, current_date, hour)
                if best_candidate is None or candidate < best_candidate:
                    best_candidate = candidate

        if best_candidate is None:
            raise PlannerValidationError(
                "No available slot found within lookahead window for scheduling constraints"
            )

        _, _, _, selected_date, selected_hour = best_candidate
        _, selected_day_offset, selected_hour_index, _, _ = best_candidate
        blocked_shift_used = any(
            (blocked_day_offset, blocked_hour_index) < (selected_day_offset, selected_hour_index)
            for blocked_day_offset, blocked_hour_index in blocked_orders
        )
        patient_busy.add((patient_uuid, selected_date, selected_hour))
        task_busy.add((task_definition_id, selected_date, selected_hour))
        return selected_date, selected_hour, blocked_shift_used, use_time_preference_bias


    def replan_and_sync(self, doctor_id: str | None = None) -> SchedulePlanResponse:
        now_utc = self._now_provider()
        planning_anchor = self._planning_anchor(now_utc)
        contexts = self._build_contexts()
        pending_cache_updates: list[PlannerLlmCacheUpdate] = []

        preference_resolution = self._preferences_service.get_preferences(doctor_id)
        preferences: PlannerPreferences = preference_resolution.preferences
        warning_codes: set[str] = set(preference_resolution.warnings)

        overrides_applied_count = 0
        time_block_shift_count = 0
        time_pref_tokens_ignored_count = 0
        time_pref_bias_applied_count = 0
        time_pref_llm_normalized_count = 0
        time_preference_profile_cache: dict[str, tuple[PatientTimePreferenceProfile, bool]] = {}

        candidate_items: list[dict[str, object]] = []
        for patient_external_id in sorted(contexts):
            context = contexts[patient_external_id]
            preference_cache_key = (context.time_preferences or "").strip()
            if preference_cache_key in time_preference_profile_cache:
                time_preference_profile, used_llm_for_time_pref = time_preference_profile_cache[
                    preference_cache_key
                ]
            else:
                time_preference_profile, used_llm_for_time_pref = self._resolve_patient_time_preferences(
                    context.time_preferences,
                    warning_codes,
                )
                time_preference_profile_cache[preference_cache_key] = (
                    time_preference_profile,
                    used_llm_for_time_pref,
                )

            time_pref_tokens_ignored_count += time_preference_profile.ignored_tokens
            if used_llm_for_time_pref:
                time_pref_llm_normalized_count += 1
            for task in context.tasks:
                context_hash = self._build_context_hash(
                    patient_description=context.description,
                    time_preferences=context.time_preferences,
                    task_name=task.task_name,
                    status=task.status.value,
                    due_at=task.due_at,
                    admitted_at=context.admitted_at,
                )
                llm_priority, _, reason = self._resolve_llm_priority(
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

                effective_priority, override_applied = self._apply_priority_overrides(
                    patient_description=context.description,
                    llm_priority=llm_priority,
                    rules=preferences.priority_overrides,
                    warnings=warning_codes,
                )
                if override_applied:
                    overrides_applied_count += 1

                _, score = self.calculate_score(
                    priority=effective_priority,
                    admitted_at=context.admitted_at,
                    now_utc=now_utc,
                    w_priority=preferences.scoring_weights.w_priority,
                    w_wait=preferences.scoring_weights.w_wait,
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
                        "priority": effective_priority,
                        "priority_score": score,
                        "reason": reason,
                        "time_preference_profile": time_preference_profile,
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
            allocated_date, allocated_hour, blocked_shift_used, time_pref_bias_applied = self._allocate_slot(
                patient_uuid=item["patient_uuid"],
                task_definition_id=item["task_definition_id"],
                preferred_date=item["preferred_date"],
                preferred_hour=item["preferred_hour"],
                patient_busy=patient_busy,
                task_busy=task_busy,
                time_blocks=preferences.time_blocks,
                time_preference_profile=item["time_preference_profile"],
                w_time_pref=preferences.scoring_weights.w_time_pref,
            )
            if blocked_shift_used:
                time_block_shift_count += 1
            if time_pref_bias_applied:
                time_pref_bias_applied_count += 1
            scheduled_for = self._schedule_datetime(allocated_date, allocated_hour)
            planned_rows.append(
                {
                    **item,
                    "scheduled_for": scheduled_for,
                    "hour": allocated_hour,
                }
            )

        if time_block_shift_count > 0:
            warning_codes.add(f"time_block_shifts:{time_block_shift_count}")
        if time_pref_tokens_ignored_count > 0:
            warning_codes.add(f"time_pref_tokens_ignored:{time_pref_tokens_ignored_count}")
        if time_pref_bias_applied_count > 0:
            warning_codes.add(f"time_pref_bias_applied_count:{time_pref_bias_applied_count}")
        if time_pref_llm_normalized_count > 0:
            warning_codes.add(f"time_pref_llm_normalized_count:{time_pref_llm_normalized_count}")

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
            "Scheduler sync completed inserted=%s updated=%s deleted=%s cache_updates=%s doctor_id=%s pref_source=%s",
            sync_result.inserted,
            sync_result.updated,
            sync_result.deleted,
            len(pending_cache_updates),
            preference_resolution.doctor_id,
            preference_resolution.source.value,
        )

        applied_preferences = AppliedPreferencesSummary(
            doctor_id=preference_resolution.doctor_id,
            source=preference_resolution.source,
            time_blocks_count=len(preferences.time_blocks),
            overrides_applied_count=overrides_applied_count,
            scoring_weights=preferences.scoring_weights,
            language=preferences.language,
        )

        return SchedulePlanResponse(
            items=self._repository.list_schedule_plan_items(),
            applied_preferences=applied_preferences,
            warnings=sorted(warning_codes),
        )

    def plan_schedule(self, doctor_id: str | None = None) -> SchedulePlanResponse:
        return self.replan_and_sync(doctor_id=doctor_id)
