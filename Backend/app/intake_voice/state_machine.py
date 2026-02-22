from __future__ import annotations

from typing import Mapping

REQUIRED_SLOTS = ("first_name", "last_name", "description", "time_preferences")

QUESTION_BY_SLOT: dict[str, str] = {
    "first_name": "What is the patient's first name?",
    "last_name": "What is the patient's last name?",
    "description": "Why does the patient need a medical test?",
    "time_preferences": "What is the preferred time for doing the test?",
}


class IntakeStateMachine:
    CONFIDENCE_THRESHOLD = 0.75

    @staticmethod
    def missing_slots(slots: Mapping[str, str | None]) -> list[str]:
        missing: list[str] = []
        for key in REQUIRED_SLOTS:
            value = slots.get(key)
            if value is None or not str(value).strip():
                missing.append(key)
        return missing

    def low_confidence_slots(self, slot_confidence: Mapping[str, float | None]) -> list[str]:
        uncertain: list[str] = []
        for key in REQUIRED_SLOTS:
            score = slot_confidence.get(key)
            if score is None:
                continue
            if score < self.CONFIDENCE_THRESHOLD:
                uncertain.append(key)
        return uncertain

    def next_question(
        self,
        slots: Mapping[str, str | None],
        slot_confidence: Mapping[str, float | None],
    ) -> str | None:
        missing = self.missing_slots(slots)
        if missing:
            return QUESTION_BY_SLOT[missing[0]]

        low_conf = self.low_confidence_slots(slot_confidence)
        if low_conf:
            slot = low_conf[0]
            return f"Please confirm {slot.replace('_', ' ')}: {slots.get(slot) or ''}".strip()

        return None

    @staticmethod
    def build_readback(slots: Mapping[str, str | None]) -> str:
        return (
            "Read-back: "
            f"first name {slots.get('first_name')}, "
            f"last name {slots.get('last_name')}, "
            f"reason {slots.get('description')}, "
            f"time preference {slots.get('time_preferences')}. "
            "Do you confirm?"
        )
