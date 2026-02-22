from __future__ import annotations

from datetime import date, datetime, timezone
from enum import Enum
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models.preferences import AppliedPreferencesSummary


class BaseSchema(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


def _normalize_datetime(value: datetime | str | None) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, str):
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    else:
        parsed = value
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


class TaskStatus(str, Enum):
    pending = "pending"
    done = "done"
    cancelled = "cancelled"


class ScheduleItemStatus(str, Enum):
    pending = "pending"
    completed = "completed"


class PatientCreate(BaseSchema):
    patient_id: int = Field(ge=1)
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=2000)
    time_preferences: Optional[str] = Field(default=None, min_length=1, max_length=1000)
    priority_final: int = Field(ge=1, le=5)
    priority_suggested: Optional[int] = Field(default=None, ge=1, le=5)
    model_reason: Optional[str] = Field(default=None, min_length=1, max_length=200)
    confidence: Optional[float] = Field(default=None, ge=0, le=1)
    override_reason: Optional[str] = Field(default=None, min_length=5, max_length=200)
    admitted_at: Optional[datetime] = None

    @field_validator("admitted_at", mode="before")
    @classmethod
    def normalize_admitted_at(cls, value: datetime | str | None) -> datetime | None:
        return _normalize_datetime(value)

    @model_validator(mode="after")
    def validate_priority_override(self) -> "PatientCreate":
        if self.priority_suggested is None:
            return self
        if self.priority_final != self.priority_suggested and not self.override_reason:
            raise ValueError("override_reason is required when priority_final differs from priority_suggested")
        return self


class PatientUpdate(BaseSchema):
    first_name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    last_name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    description: Optional[str] = Field(default=None, min_length=1, max_length=2000)
    time_preferences: Optional[str] = Field(default=None, min_length=1, max_length=1000)
    priority_final: Optional[int] = Field(default=None, ge=1, le=5)
    priority_suggested: Optional[int] = Field(default=None, ge=1, le=5)
    model_reason: Optional[str] = Field(default=None, min_length=1, max_length=200)
    confidence: Optional[float] = Field(default=None, ge=0, le=1)
    override_reason: Optional[str] = Field(default=None, min_length=5, max_length=200)
    admitted_at: Optional[datetime] = None

    @field_validator("admitted_at", mode="before")
    @classmethod
    def normalize_admitted_at(cls, value: datetime | str | None) -> datetime | None:
        return _normalize_datetime(value)

    @model_validator(mode="after")
    def validate_not_empty(self) -> "PatientUpdate":
        if not self.model_fields_set:
            raise ValueError("At least one field must be provided")
        return self

    @model_validator(mode="after")
    def validate_priority_override(self) -> "PatientUpdate":
        if self.priority_final is None or self.priority_suggested is None:
            return self
        if self.priority_final != self.priority_suggested and not self.override_reason:
            raise ValueError("override_reason is required when priority_final differs from priority_suggested")
        return self


class PatientResponse(BaseSchema):
    id: UUID
    patient_id: int
    first_name: str
    last_name: str
    description: str
    time_preferences: Optional[str] = None
    priority_final: int = Field(ge=1, le=5)
    priority_suggested: Optional[int] = Field(default=None, ge=1, le=5)
    model_reason: Optional[str] = Field(default=None, min_length=1, max_length=200)
    confidence: Optional[float] = Field(default=None, ge=0, le=1)
    override_reason: Optional[str] = Field(default=None, min_length=5, max_length=200)
    admitted_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime


class PriorityPreviewRequest(BaseSchema):
    first_name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    last_name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=2000)
    time_preferences: Optional[str] = Field(default=None, min_length=1, max_length=1000)
    admitted_at: Optional[datetime] = None
    task_names: Optional[list[str]] = None

    @field_validator("admitted_at", mode="before")
    @classmethod
    def normalize_admitted_at(cls, value: datetime | str | None) -> datetime | None:
        return _normalize_datetime(value)


class PriorityPreviewResponse(BaseSchema):
    suggested_priority: int = Field(ge=1, le=5)
    confidence: float = Field(ge=0, le=1)
    model_reason: str = Field(min_length=1, max_length=200)


class TaskDefinitionCreate(BaseSchema):
    name: str = Field(min_length=1, max_length=255)


class TaskDefinitionUpdate(BaseSchema):
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)

    @model_validator(mode="after")
    def validate_not_empty(self) -> "TaskDefinitionUpdate":
        if not self.model_fields_set:
            raise ValueError("At least one field must be provided")
        return self


class TaskDefinitionResponse(BaseSchema):
    id: UUID
    name: str
    created_at: datetime
    updated_at: datetime


class PatientTaskAssignCreate(BaseSchema):
    task_definition_id: UUID
    due_at: Optional[datetime] = None
    status: TaskStatus = TaskStatus.pending

    @field_validator("due_at", mode="before")
    @classmethod
    def normalize_due_at(cls, value: datetime | str | None) -> datetime | None:
        return _normalize_datetime(value)


class PatientTaskUpdate(BaseSchema):
    status: Optional[TaskStatus] = None
    due_at: Optional[datetime] = None

    @field_validator("due_at", mode="before")
    @classmethod
    def normalize_due_at(cls, value: datetime | str | None) -> datetime | None:
        return _normalize_datetime(value)

    @model_validator(mode="after")
    def validate_not_empty(self) -> "PatientTaskUpdate":
        if not self.model_fields_set:
            raise ValueError("At least one field must be provided")
        return self


class PatientTaskResponse(BaseSchema):
    id: UUID
    patient_id: UUID
    patient_external_id: Optional[int] = None
    task_definition_id: UUID
    task_name: str
    status: TaskStatus
    due_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime


class ScheduleItemResponse(BaseSchema):
    id: UUID
    patient_id: UUID
    patient_external_id: Optional[int] = None
    task_definition_id: Optional[UUID] = None
    source_patient_task_id: Optional[UUID] = None
    task_name: str
    scheduled_for: datetime
    status: ScheduleItemStatus = ScheduleItemStatus.pending
    completed_at: Optional[datetime] = None
    priority: int = Field(ge=1, le=5)
    score: float = Field(ge=0)
    created_at: datetime


class LlmPriorityResult(BaseSchema):
    priority: int = Field(ge=1, le=5)
    confidence: float = Field(ge=0, le=1)
    reason: str = Field(min_length=1, max_length=200)


class TimePreferenceWindow(BaseSchema):
    start: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    end: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")

    @staticmethod
    def _to_minutes(value: str) -> int:
        hour, minute = value.split(":", 1)
        return int(hour) * 60 + int(minute)

    @model_validator(mode="after")
    def validate_range(self) -> "TimePreferenceWindow":
        if self._to_minutes(self.start) >= self._to_minutes(self.end):
            raise ValueError("time window start must be before end")
        return self


class LlmTimePreferenceNormalization(BaseSchema):
    preferred_windows: list[TimePreferenceWindow] = Field(default_factory=list)
    avoid_windows: list[TimePreferenceWindow] = Field(default_factory=list)
    confidence: float = Field(default=0.0, ge=0, le=1)
    reason: str = Field(default="fallback", min_length=1, max_length=200)


class PlannedScheduleItem(BaseSchema):
    schedule_item_id: UUID
    task_name: str
    patient_name: str
    day: date
    hour: int = Field(ge=9, le=21)
    priority_score: float = Field(ge=0)
    reason: str = Field(min_length=1, max_length=200)
    status: ScheduleItemStatus = ScheduleItemStatus.pending
    source_patient_task_id: Optional[UUID] = None


class ScheduleCompleteRequest(BaseSchema):
    schedule_item_ids: list[UUID] = Field(min_length=1)


class ScheduleCompleteResponse(BaseSchema):
    completed_ids: list[UUID] = Field(default_factory=list)
    skipped_ids: list[UUID] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class ScheduleRescheduleOption(BaseSchema):
    scheduled_for: datetime
    day: date
    hour: int = Field(ge=9, le=21)


class ScheduleRescheduleOptionsResponse(BaseSchema):
    schedule_item_id: UUID
    options: list[ScheduleRescheduleOption] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class ScheduleRescheduleRequest(BaseSchema):
    scheduled_for: datetime

    @field_validator("scheduled_for", mode="before")
    @classmethod
    def normalize_scheduled_for(cls, value: datetime | str) -> datetime:
        normalized = _normalize_datetime(value)
        if normalized is None:
            raise ValueError("scheduled_for is required")
        return normalized

    @model_validator(mode="after")
    def validate_hour_boundary(self) -> "ScheduleRescheduleRequest":
        if self.scheduled_for.minute != 0 or self.scheduled_for.second != 0 or self.scheduled_for.microsecond != 0:
            raise ValueError("scheduled_for must be aligned to an exact hour")
        if self.scheduled_for.hour < 9 or self.scheduled_for.hour > 21:
            raise ValueError("scheduled_for hour must be between 09:00 and 21:00 UTC")
        return self


class ScheduleRescheduleResponse(BaseSchema):
    schedule_item_id: UUID
    scheduled_for: datetime
    notice: str


class RemoveFlowStartResponse(BaseSchema):
    original_schedule_item_id: UUID
    working_schedule_item_id: UUID
    source_patient_task_id: UUID
    options: list[ScheduleRescheduleOption] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class RemoveFlowApplyRequest(ScheduleRescheduleRequest):
    pass


class RemoveFlowApplyResponse(BaseSchema):
    schedule_item_id: UUID
    scheduled_for: datetime
    notice: str


class RemoveFlowCancelResponse(BaseSchema):
    schedule_item_id: UUID
    source_patient_task_id: UUID
    notice: str


class SchedulePlanResponse(BaseSchema):
    items: list[PlannedScheduleItem]
    applied_preferences: AppliedPreferencesSummary | None = None
    warnings: list[str] = Field(default_factory=list)


class HealthResponse(BaseSchema):
    status: str
    env: str


class PlannerTaskContext(BaseSchema):
    id: UUID
    task_definition_id: UUID
    task_name: str
    status: TaskStatus
    due_at: Optional[datetime] = None
    llm_priority: Optional[int] = Field(default=None, ge=1, le=5)
    llm_confidence: Optional[float] = Field(default=None, ge=0, le=1)
    llm_reason: Optional[str] = Field(default=None, min_length=1, max_length=200)
    llm_context_hash: Optional[str] = Field(default=None, min_length=1, max_length=128)
    llm_scored_at: Optional[datetime] = None


class PlannerPatientContext(BaseSchema):
    patient_uuid: UUID
    patient_external_id: int
    patient_name: str
    description: str
    time_preferences: Optional[str] = None
    admitted_at: Optional[datetime] = None
    tasks: list[PlannerTaskContext] = Field(default_factory=list)


class PlannerLlmCacheUpdate(BaseSchema):
    patient_task_id: UUID
    llm_priority: int = Field(ge=1, le=5)
    llm_confidence: float = Field(ge=0, le=1)
    llm_reason: str = Field(min_length=1, max_length=200)
    llm_context_hash: str = Field(min_length=1, max_length=128)
    llm_scored_at: datetime


class ScheduleSyncResult(BaseSchema):
    inserted: int = Field(ge=0)
    updated: int = Field(ge=0)
    deleted: int = Field(ge=0)
