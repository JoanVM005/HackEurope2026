from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models.schemas import PatientResponse, PatientTaskResponse


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


class VoiceIntakeStatus(str, Enum):
    collecting = "collecting"
    confirming = "confirming"
    complete = "complete"
    pending_review = "pending_review"
    confirmed = "confirmed"
    discarded = "discarded"
    error = "error"


class VoiceIntakeSlots(BaseSchema):
    first_name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    last_name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    description: Optional[str] = Field(default=None, min_length=1, max_length=2000)
    time_preferences: Optional[str] = Field(default=None, min_length=1, max_length=1000)


class VoiceIntakeSessionCreateRequest(BaseSchema):
    language: str = Field(default="en", min_length=2, max_length=8)


class VoiceIntakeSessionCreateResponse(BaseSchema):
    session_id: UUID
    status: VoiceIntakeStatus
    updated_slots: VoiceIntakeSlots
    next_question: str
    warnings: list[str] = Field(default_factory=list)


class VoiceIntakeSessionSummary(BaseSchema):
    session_id: UUID
    status: VoiceIntakeStatus
    created_at: datetime
    updated_at: datetime
    extracted_data: VoiceIntakeSlots
    suggested_task_names: list[str] = Field(default_factory=list)
    priority_suggested: Optional[int] = Field(default=None, ge=1, le=5)
    priority_confidence: Optional[float] = Field(default=None, ge=0, le=1)
    priority_reason: Optional[str] = None
    pdf_url: Optional[str] = None
    warnings: list[str] = Field(default_factory=list)


class VoiceIntakeSessionListResponse(BaseSchema):
    sessions: list[VoiceIntakeSessionSummary] = Field(default_factory=list)


class VoiceTurnRequest(BaseSchema):
    client_turn_id: Optional[UUID] = None
    transcript_chunk: str = Field(min_length=1, max_length=3000)
    source: Literal["voice", "text_fallback"]
    stt_confidence: Optional[float] = Field(default=None, ge=0, le=1)
    captured_at: Optional[datetime] = None

    @field_validator("captured_at", mode="before")
    @classmethod
    def normalize_captured_at(cls, value: datetime | str | None) -> datetime | None:
        return _normalize_datetime(value)


class VoiceTurnResponse(BaseSchema):
    session_id: UUID
    status: VoiceIntakeStatus
    updated_slots: VoiceIntakeSlots
    slot_confidence: dict[str, float] = Field(default_factory=dict)
    missing_slots: list[str] = Field(default_factory=list)
    next_question: str
    partial_summary: str
    warnings: list[str] = Field(default_factory=list)
    needs_follow_up: bool = False


class VoiceFinalizeRequest(BaseSchema):
    final_confirmation: Optional[Literal["voice_yes", "ui_confirm"]] = None
    regenerate_pdf: bool = False


class VoiceTaskSuggestions(BaseSchema):
    suggested_task_definition_ids: list[UUID] = Field(default_factory=list)
    suggested_task_names: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class VoicePrioritySuggestion(BaseSchema):
    suggested_priority: int = Field(ge=1, le=5)
    confidence: float = Field(ge=0, le=1)
    model_reason: str = Field(min_length=1, max_length=200)


class VoiceTranscriptArtifact(BaseSchema):
    pdf_path: str
    pdf_url: str
    turn_count: int = Field(ge=0)


class VoicePendingReviewPayload(BaseSchema):
    session_id: UUID
    status: VoiceIntakeStatus
    transcript: VoiceTranscriptArtifact
    extracted_data: VoiceIntakeSlots
    task_suggestions: VoiceTaskSuggestions
    priority_suggestion: VoicePrioritySuggestion


class VoiceConfirmRequest(BaseSchema):
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=2000)
    time_preferences: Optional[str] = Field(default=None, min_length=1, max_length=1000)
    admitted_at: Optional[datetime] = None
    priority_final: int = Field(ge=1, le=5)
    priority_suggested: Optional[int] = Field(default=None, ge=1, le=5)
    confidence: Optional[float] = Field(default=None, ge=0, le=1)
    model_reason: Optional[str] = Field(default=None, min_length=1, max_length=200)
    override_reason: Optional[str] = Field(default=None, min_length=5, max_length=200)
    selected_task_definition_ids: list[UUID] = Field(min_length=1)

    @field_validator("admitted_at", mode="before")
    @classmethod
    def normalize_admitted_at(cls, value: datetime | str | None) -> datetime | None:
        return _normalize_datetime(value)


class VoiceConfirmResponse(BaseSchema):
    patient: PatientResponse
    tasks: list[PatientTaskResponse] = Field(default_factory=list)
    session_status: VoiceIntakeStatus
    warnings: list[str] = Field(default_factory=list)


class VoiceTranscriptionResponse(BaseSchema):
    transcript: str = Field(min_length=1)
    confidence: Optional[float] = Field(default=None, ge=0, le=1)
    provider: str = Field(default="elevenlabs")
    warnings: list[str] = Field(default_factory=list)
