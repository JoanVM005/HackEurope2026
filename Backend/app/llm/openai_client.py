from __future__ import annotations

import json
import logging
from functools import lru_cache
from typing import Any, Mapping

from langchain_core.exceptions import OutputParserException
from langchain_core.output_parsers import PydanticOutputParser
from langchain_core.prompts import ChatPromptTemplate
from langchain_openai import ChatOpenAI
from openai import APIConnectionError, APIError, APITimeoutError, RateLimitError
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from app.config import get_settings
from app.models.schemas import LlmPriorityResult, LlmTimePreferenceNormalization

logger = logging.getLogger(__name__)

PRIORITY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "priority": {"type": "integer", "minimum": 1, "maximum": 5},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "reason": {"type": "string", "minLength": 1, "maxLength": 200},
    },
    "required": ["priority", "confidence", "reason"],
    "additionalProperties": False,
}

TIME_PREFERENCE_NORMALIZATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "preferred_windows": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start": {"type": "string", "pattern": r"^([01]\d|2[0-3]):[0-5]\d$"},
                    "end": {"type": "string", "pattern": r"^([01]\d|2[0-3]):[0-5]\d$"},
                },
                "required": ["start", "end"],
                "additionalProperties": False,
            },
        },
        "avoid_windows": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start": {"type": "string", "pattern": r"^([01]\d|2[0-3]):[0-5]\d$"},
                    "end": {"type": "string", "pattern": r"^([01]\d|2[0-3]):[0-5]\d$"},
                },
                "required": ["start", "end"],
                "additionalProperties": False,
            },
        },
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "reason": {"type": "string", "minLength": 1, "maxLength": 200},
    },
    "required": ["preferred_windows", "avoid_windows", "confidence", "reason"],
    "additionalProperties": False,
}
SYSTEM_PROMPT = (
    "You are an operational scheduling prioritization assistant for a hospital workflow planner. "
    "Score only from provided operational context. "
    "Do not invent facts. "
    "Do not use diagnosis assumptions. "
    "Return strictly one JSON object matching the schema. "
    "Prioritize with this rubric: "
    "priority=5 for immediate operational risk (already overdue, severe delay risk, or blocking critical workflow), "
    "priority=4 for high urgency within the next planning window, "
    "priority=3 for normal active work, "
    "priority=2 for low urgency and can be deferred, "
    "priority=1 for backlog/non-urgent. "
    "Confidence must reflect data quality and signal strength: high when context is explicit, low when sparse/conflicting. "
    "Reason must be concise, concrete, and <=200 chars."
)

TIME_PREFERENCE_SYSTEM_PROMPT = (
    "You normalize free-text patient time preferences into concrete scheduling windows. "
    "Return strictly one JSON object matching the schema. "
    "Do not infer medical facts. "
    "Map natural language and shorthand times into 24h HH:MM ranges. "
    "Interpret examples such as '9-12', '9am-12pm', 'mornings', 'after lunch'. "
    "Use only ranges within 09:00-21:00, clipping if needed. "
    "If text is ambiguous, keep arrays empty and lower confidence."
)

MAX_PATIENT_DESCRIPTION_CHARS = 2_000
MAX_TASK_TITLE_CHARS = 180
MAX_TASK_DETAILS_CHARS = 2_000
MAX_TIME_PREFERENCE_TEXT_CHARS = 1_000


class LlmServiceError(Exception):
    """Raised for generic LLM integration errors."""


class LlmTransientError(LlmServiceError):
    """Raised for retryable network/rate-limit errors."""


class OpenAIPlannerClient:
    def __init__(self, api_key: str, model: str):
        self._model = model
        self._parser = PydanticOutputParser(pydantic_object=LlmPriorityResult)
        self._prompt = ChatPromptTemplate.from_messages(
            [
                ("system", SYSTEM_PROMPT),
                ("system", "{format_instructions}"),
                ("user", "{user_prompt}"),
            ]
        )
        self._llm = ChatOpenAI(model=model, api_key=api_key, temperature=0)
        self._chain = self._prompt | self._llm | self._parser
        self._time_pref_parser = PydanticOutputParser(pydantic_object=LlmTimePreferenceNormalization)
        self._time_pref_prompt = ChatPromptTemplate.from_messages(
            [
                ("system", TIME_PREFERENCE_SYSTEM_PROMPT),
                ("system", "{format_instructions}"),
                ("user", "{user_prompt}"),
            ]
        )
        self._time_pref_chain = self._time_pref_prompt | self._llm | self._time_pref_parser

    @staticmethod
    def _sanitize_text(value: str, max_chars: int) -> str:
        compact = " ".join(value.split())
        if len(compact) <= max_chars:
            return compact
        return compact[: max_chars - 3].rstrip() + "..."

    @staticmethod
    def _format_detail_value(value: Any) -> str:
        if isinstance(value, (dict, list)):
            return json.dumps(value, separators=(",", ":"), sort_keys=True)
        return str(value)

    @staticmethod
    def _format_task_details(task_details: str | None) -> str:
        if not task_details or not task_details.strip():
            return "none provided"

        raw = task_details.strip()
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return OpenAIPlannerClient._sanitize_text(raw, MAX_TASK_DETAILS_CHARS)

        if isinstance(parsed, Mapping):
            parts: list[str] = []
            for key in sorted(parsed):
                value = OpenAIPlannerClient._format_detail_value(parsed[key])
                value = OpenAIPlannerClient._sanitize_text(value, 240)
                parts.append(f"{key}={value}")
            details = "; ".join(parts)
            return OpenAIPlannerClient._sanitize_text(details, MAX_TASK_DETAILS_CHARS)

        if isinstance(parsed, list):
            rendered = OpenAIPlannerClient._format_detail_value(parsed)
            return OpenAIPlannerClient._sanitize_text(rendered, MAX_TASK_DETAILS_CHARS)

        return OpenAIPlannerClient._sanitize_text(str(parsed), MAX_TASK_DETAILS_CHARS)

    @staticmethod
    def _build_user_prompt(patient_description: str, task_title: str, task_details: str | None) -> str:
        patient_context = OpenAIPlannerClient._sanitize_text(
            patient_description, MAX_PATIENT_DESCRIPTION_CHARS
        )
        normalized_title = OpenAIPlannerClient._sanitize_text(task_title, MAX_TASK_TITLE_CHARS)
        details = OpenAIPlannerClient._format_task_details(task_details)
        return (
            "Estimate priority for this scheduling task.\n"
            "Use operational factors such as due timing, waiting pressure, attendance behavior, "
            "and workflow impact if the task is delayed.\n"
            f"Patient context: {patient_context}\n"
            f"Task title: {normalized_title}\n"
            f"Task details: {details}\n"
            "Return JSON only."
        )

    @retry(
        retry=retry_if_exception_type(LlmTransientError),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=0.5, min=0.5, max=4),
        reraise=True,
    )
    def _invoke_chain(self, user_prompt: str) -> LlmPriorityResult:
        try:
            return self._chain.invoke(
                {
                    "user_prompt": user_prompt,
                    "format_instructions": self._parser.get_format_instructions(),
                }
            )
        except (RateLimitError, APITimeoutError, APIConnectionError) as exc:
            raise LlmTransientError("Transient OpenAI error") from exc
        except APIError as exc:
            if getattr(exc, "status_code", None) and int(exc.status_code) >= 500:
                raise LlmTransientError("OpenAI 5xx error") from exc
            raise
    def _build_time_preference_user_prompt(self, raw_time_preferences: str) -> str:
        normalized = self._sanitize_text(raw_time_preferences, MAX_TIME_PREFERENCE_TEXT_CHARS)
        return (
            "Normalize this patient time-preference text for scheduling.\n"
            "Output windows as preferred or avoid ranges.\n"
            f"Raw text: {normalized}\n"
            "Return JSON only."
        )

    @retry(
        retry=retry_if_exception_type(LlmTransientError),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=0.5, min=0.5, max=4),
        reraise=True,
    )
    def _invoke_time_preference_chain(
        self,
        raw_time_preferences: str,
    ) -> LlmTimePreferenceNormalization:
        user_prompt = self._build_time_preference_user_prompt(raw_time_preferences)
        try:
            return self._time_pref_chain.invoke(
                {
                    "user_prompt": user_prompt,
                    "format_instructions": self._time_pref_parser.get_format_instructions(),
                }
            )
        except (RateLimitError, APITimeoutError, APIConnectionError) as exc:
            raise LlmTransientError("Transient OpenAI error") from exc
        except APIError as exc:
            if getattr(exc, "status_code", None) and int(exc.status_code) >= 500:
                raise LlmTransientError("OpenAI 5xx error") from exc
            raise
    def estimate_priority(
        self,
        patient_description: str,
        task_title: str,
        task_details: str | None,
    ) -> LlmPriorityResult:
        user_prompt = self._build_user_prompt(
            patient_description=patient_description,
            task_title=task_title,
            task_details=task_details,
        )

        try:
            return self._invoke_chain(user_prompt)
        except OutputParserException as exc:
            logger.warning("LangChain parsing failed; using fallback priority", exc_info=exc)
        except Exception as exc:  # noqa: BLE001
            logger.error("LangChain call failed; using fallback priority", exc_info=exc)

        return LlmPriorityResult(
            priority=3,
            confidence=0.0,
            reason="defaulted due to llm failure",
        )

    def estimate_priority_from_features(
        self,
        patient_description: str,
        task_title: str,
        operational_features: dict[str, Any] | None = None,
    ) -> LlmPriorityResult:
        details = (
            json.dumps(operational_features, separators=(",", ":"), sort_keys=True)
            if operational_features is not None
            else None
        )
        return self.estimate_priority(
            patient_description=patient_description,
            task_title=task_title,
            task_details=details,
        )

    def normalize_time_preferences(
        self,
        raw_time_preferences: str,
    ) -> LlmTimePreferenceNormalization | None:
        cleaned = raw_time_preferences.strip()
        if not cleaned:
            return None

        try:
            return self._invoke_time_preference_chain(cleaned)
        except OutputParserException as exc:
            logger.warning("Time-preference parsing failed", exc_info=exc)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Time-preference LLM normalization failed", exc_info=exc)
        return None


def get_openai_planner_client() -> OpenAIPlannerClient:
    resolved_settings = get_settings()
    return OpenAIPlannerClient(
        api_key=resolved_settings.openai_api_key,
        model=resolved_settings.openai_model,
    )
