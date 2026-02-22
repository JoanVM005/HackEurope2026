from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class BasePreferenceSchema(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class PreferenceLanguage(str, Enum):
    es = "es"
    en = "en"


class PreferencesSource(str, Enum):
    mem0 = "mem0"
    default = "default"


class MatchType(str, Enum):
    contains = "contains"
    regex = "regex"


class TimeBlock(BasePreferenceSchema):
    start: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    end: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")

    @staticmethod
    def _to_minutes(value: str) -> int:
        hour, minute = value.split(":", 1)
        return int(hour) * 60 + int(minute)

    @model_validator(mode="after")
    def validate_range(self) -> "TimeBlock":
        if self._to_minutes(self.start) >= self._to_minutes(self.end):
            raise ValueError("time block start must be before end")
        return self


class PriorityOverrideRule(BasePreferenceSchema):
    match_type: MatchType = MatchType.contains
    pattern: str = Field(min_length=1, max_length=120)
    priority: int = Field(ge=1, le=5)
    enabled: bool = True

    @field_validator("pattern")
    @classmethod
    def validate_pattern(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("pattern cannot be empty")
        return cleaned


class ScoringWeights(BasePreferenceSchema):
    w_priority: float = Field(default=10.0, ge=1.0, le=20.0)
    w_wait: float = Field(default=0.05, ge=0.0, le=1.0)


class ExplanationPreferences(BasePreferenceSchema):
    include_reason: bool = True
    include_formula: bool = False


class PlannerPreferences(BasePreferenceSchema):
    time_blocks: list[TimeBlock] = Field(default_factory=list)
    priority_overrides: list[PriorityOverrideRule] = Field(default_factory=list)
    scoring_weights: ScoringWeights = Field(default_factory=ScoringWeights)
    language: PreferenceLanguage = PreferenceLanguage.es
    explanations: ExplanationPreferences = Field(default_factory=ExplanationPreferences)


class PlannerPreferencesUpdate(BasePreferenceSchema):
    time_blocks: Optional[list[TimeBlock]] = None
    priority_overrides: Optional[list[PriorityOverrideRule]] = None
    scoring_weights: Optional[ScoringWeights] = None
    language: Optional[PreferenceLanguage] = None
    explanations: Optional[ExplanationPreferences] = None


class AppliedPreferencesSummary(BasePreferenceSchema):
    doctor_id: str = Field(min_length=1, max_length=100)
    source: PreferencesSource
    time_blocks_count: int = Field(ge=0)
    overrides_applied_count: int = Field(ge=0)
    scoring_weights: ScoringWeights
    language: PreferenceLanguage


class PreferencesPayloadResponse(BasePreferenceSchema):
    doctor_id: str = Field(min_length=1, max_length=100)
    source: PreferencesSource
    preferences: PlannerPreferences
    warnings: list[str] = Field(default_factory=list)
