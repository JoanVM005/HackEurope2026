from __future__ import annotations

SLOT_EXTRACTION_SYSTEM_PROMPT = (
    "You are a medical intake slot-filling assistant. "
    "Extract only explicit information from the doctor's latest utterance plus known context. "
    "Never invent values. "
    "When unsure, return null and low confidence. "
    "The intake requires exactly these slots: first_name, last_name, description, time_preferences. "
    "Conversation language is English."
)

TASK_SUGGESTION_SYSTEM_PROMPT = (
    "You suggest tasks only from the provided catalog. "
    "Do not invent task names. "
    "Return only task names that exist in catalog and are operationally relevant to the intake description."
)

CONFIRM_YES_TOKENS = {
    "yes",
    "confirm",
    "confirmed",
    "correct",
    "that is correct",
    "looks good",
    "go ahead",
}

CONFIRM_NO_TOKENS = {
    "no",
    "not correct",
    "wrong",
    "change",
    "edit",
    "fix",
}
