from __future__ import annotations

import logging
from dataclasses import dataclass

from app.config import get_settings
from app.memory.mem0_client import Mem0Client, Mem0Error, get_mem0_client
from app.models.preferences import (
    PlannerPreferences,
    PlannerPreferencesUpdate,
    PreferencesPayloadResponse,
    PreferencesSource,
)

logger = logging.getLogger(__name__)

DEFAULT_PREFERENCES = PlannerPreferences(
    time_blocks=[],
    priority_overrides=[],
)


class PreferencesServiceError(Exception):
    """Raised when preferences cannot be persisted."""


@dataclass
class PreferencesResolution:
    doctor_id: str
    source: PreferencesSource
    preferences: PlannerPreferences
    warnings: list[str]


class PreferencesService:
    def __init__(self, mem0_client: Mem0Client | None):
        self._mem0_client = mem0_client

    @staticmethod
    def resolve_doctor_id(doctor_id: str | None) -> str:
        cleaned = (doctor_id or "").strip()
        if cleaned:
            return cleaned
        return get_settings().default_doctor_id

    def get_preferences(self, doctor_id: str | None) -> PreferencesResolution:
        resolved_doctor_id = self.resolve_doctor_id(doctor_id)
        warnings: list[str] = []

        if self._mem0_client is None:
            warnings.append("mem0_not_configured_using_defaults")
            return PreferencesResolution(
                doctor_id=resolved_doctor_id,
                source=PreferencesSource.default,
                preferences=DEFAULT_PREFERENCES.model_copy(deep=True),
                warnings=warnings,
            )

        try:
            stored_preferences = self._mem0_client.get_preferences(resolved_doctor_id)
        except Mem0Error:
            logger.exception("Failed to load preferences from Mem0 doctor_id=%s", resolved_doctor_id)
            warnings.append("mem0_unavailable_using_defaults")
            return PreferencesResolution(
                doctor_id=resolved_doctor_id,
                source=PreferencesSource.default,
                preferences=DEFAULT_PREFERENCES.model_copy(deep=True),
                warnings=warnings,
            )

        if stored_preferences is None:
            return PreferencesResolution(
                doctor_id=resolved_doctor_id,
                source=PreferencesSource.default,
                preferences=DEFAULT_PREFERENCES.model_copy(deep=True),
                warnings=warnings,
            )

        return PreferencesResolution(
            doctor_id=resolved_doctor_id,
            source=PreferencesSource.mem0,
            preferences=stored_preferences,
            warnings=warnings,
        )

    def upsert_preferences(
        self,
        doctor_id: str | None,
        payload: PlannerPreferencesUpdate,
    ) -> PreferencesResolution:
        if self._mem0_client is None:
            raise PreferencesServiceError("Mem0 is not configured")

        current = self.get_preferences(doctor_id)
        merged_payload = current.preferences.model_dump(mode="json")
        merged_payload.update(payload.model_dump(exclude_unset=True, mode="json"))
        merged_preferences = PlannerPreferences.model_validate(merged_payload)

        try:
            persisted = self._mem0_client.upsert_preferences(current.doctor_id, merged_preferences)
        except Mem0Error as exc:
            logger.exception("Failed to persist preferences doctor_id=%s", current.doctor_id)
            raise PreferencesServiceError("Unable to persist preferences in Mem0") from exc

        return PreferencesResolution(
            doctor_id=current.doctor_id,
            source=PreferencesSource.mem0,
            preferences=persisted,
            warnings=current.warnings,
        )

    @staticmethod
    def to_response(resolution: PreferencesResolution) -> PreferencesPayloadResponse:
        return PreferencesPayloadResponse(
            doctor_id=resolution.doctor_id,
            source=resolution.source,
            preferences=resolution.preferences,
            warnings=resolution.warnings,
        )


def get_preferences_service() -> PreferencesService:
    return PreferencesService(mem0_client=get_mem0_client())
