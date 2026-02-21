from __future__ import annotations

from datetime import date, datetime, timezone
from enum import Enum
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


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


class PatientCreate(BaseSchema):
    patient_id: str = Field(min_length=1, max_length=100)
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=2000)
    admitted_at: Optional[datetime] = None

    @field_validator("admitted_at", mode="before")
    @classmethod
    def normalize_admitted_at(cls, value: datetime | str | None) -> datetime | None:
        return _normalize_datetime(value)


class PatientUpdate(BaseSchema):
    first_name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    last_name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    description: Optional[str] = Field(default=None, min_length=1, max_length=2000)
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


class PatientResponse(BaseSchema):
    id: UUID
    patient_id: str
    first_name: str
    last_name: str
    description: str
    admitted_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime


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
    patient_external_id: Optional[str] = None
    task_definition_id: UUID
    task_name: str
    status: TaskStatus
    due_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime


class ScheduleItemResponse(BaseSchema):
    id: UUID
    patient_id: UUID
    patient_external_id: Optional[str] = None
    task_definition_id: Optional[UUID] = None
    source_patient_task_id: Optional[UUID] = None
    task_name: str
    scheduled_for: datetime
    priority: int = Field(ge=1, le=5)
    score: float = Field(ge=0)
    created_at: datetime


class LlmPriorityResult(BaseSchema):
    priority: int = Field(ge=1, le=5)
    confidence: float = Field(ge=0, le=1)
    reason: str = Field(min_length=1, max_length=200)


class PlannedScheduleItem(BaseSchema):
    schedule_item_id: UUID
    task_name: str
    patient_name: str
    day: date
    hour: int = Field(ge=9, le=21)
    priority_score: float = Field(ge=0)
    reason: str = Field(min_length=1, max_length=200)


class SchedulePlanResponse(BaseSchema):
    items: list[PlannedScheduleItem]


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
    patient_external_id: str
    patient_name: str
    description: str
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
