from __future__ import annotations

import json
import logging
import re
from functools import lru_cache
from typing import Any

from openai import APIConnectionError, APIError, APITimeoutError, BadRequestError, OpenAI, RateLimitError
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from app.config import get_settings
from app.models.schemas import LlmPriorityResult

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

SYSTEM_PROMPT = (
    "You are a hospital triage prioritization assistant. "
    "Return only the requested JSON values and avoid extra detail."
)


class LlmServiceError(Exception):
    """Raised for generic LLM integration errors."""


class LlmTransientError(LlmServiceError):
    """Raised for retryable network/rate-limit errors."""


class OpenAIPlannerClient:
    def __init__(self, client: OpenAI, model: str):
        self._client = client
        self._model = model

    @staticmethod
    def _build_user_prompt(patient_description: str, task_title: str, task_details: str | None) -> str:
        details = task_details or ""
        return (
            "Estimate urgency for this task.\n"
            f"Patient context: {patient_description}\n"
            f"Task title: {task_title}\n"
            f"Task details: {details}\n"
            "Output the JSON object only."
        )

    @staticmethod
    def _extract_output_text(response: Any) -> str:
        text = getattr(response, "output_text", None)
        if isinstance(text, str) and text.strip():
            return text

        output_items = getattr(response, "output", None)
        if not isinstance(output_items, list):
            return ""

        chunks: list[str] = []
        for item in output_items:
            content_list = getattr(item, "content", None)
            if content_list is None and isinstance(item, dict):
                content_list = item.get("content")
            if not isinstance(content_list, list):
                continue

            for content in content_list:
                part_type = getattr(content, "type", None)
                if part_type is None and isinstance(content, dict):
                    part_type = content.get("type")
                if part_type not in {"output_text", "text"}:
                    continue

                text_value = getattr(content, "text", None)
                if text_value is None and isinstance(content, dict):
                    text_value = content.get("text")
                if isinstance(text_value, str):
                    chunks.append(text_value)

        return "\n".join(chunks).strip()

    @staticmethod
    def _extract_parsed_json(response: Any) -> dict[str, Any] | None:
        output_items = getattr(response, "output", None)
        if not isinstance(output_items, list):
            return None

        for item in output_items:
            content_list = getattr(item, "content", None)
            if content_list is None and isinstance(item, dict):
                content_list = item.get("content")
            if not isinstance(content_list, list):
                continue

            for content in content_list:
                parsed = getattr(content, "parsed", None)
                if parsed is None and isinstance(content, dict):
                    parsed = content.get("parsed")
                if isinstance(parsed, dict):
                    return parsed
        return None

    @retry(
        retry=retry_if_exception_type(LlmTransientError),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=0.5, min=0.5, max=4),
        reraise=True,
    )
    def _responses_create(self, **kwargs: Any) -> Any:
        try:
            return self._client.responses.create(**kwargs)
        except (RateLimitError, APITimeoutError, APIConnectionError) as exc:
            raise LlmTransientError("Transient OpenAI error") from exc
        except APIError as exc:
            if getattr(exc, "status_code", None) and int(exc.status_code) >= 500:
                raise LlmTransientError("OpenAI 5xx error") from exc
            raise

    @staticmethod
    def _safe_json_loads(raw_text: str) -> dict[str, Any]:
        cleaned = raw_text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.strip("`")
            cleaned = cleaned.replace("json\n", "", 1)

        try:
            data = json.loads(cleaned)
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            pass

        match = re.search(r"\{.*\}", raw_text, flags=re.DOTALL)
        if not match:
            raise ValueError("No JSON object found in model output")
        data = json.loads(match.group(0))
        if not isinstance(data, dict):
            raise ValueError("Model output is not a JSON object")
        return data

    def _parse_response_payload(self, response: Any) -> LlmPriorityResult:
        parsed = self._extract_parsed_json(response)
        if isinstance(parsed, dict):
            return LlmPriorityResult.model_validate(parsed)

        output_text = self._extract_output_text(response)
        if not output_text:
            raise LlmServiceError("OpenAI returned empty output")
        return LlmPriorityResult.model_validate(self._safe_json_loads(output_text))

    def _request_structured_output(
        self,
        patient_description: str,
        task_title: str,
        task_details: str | None,
    ) -> LlmPriorityResult:
        response = self._responses_create(
            model=self._model,
            input=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": self._build_user_prompt(
                        patient_description=patient_description,
                        task_title=task_title,
                        task_details=task_details,
                    ),
                },
            ],
            # Structured Outputs in Responses API: text.format with strict json_schema.
            text={
                "format": {
                    "type": "json_schema",
                    "name": "triage_priority",
                    "schema": PRIORITY_SCHEMA,
                    "strict": True,
                }
            },
        )
        return self._parse_response_payload(response)

    def _request_json_mode(
        self,
        patient_description: str,
        task_title: str,
        task_details: str | None,
    ) -> LlmPriorityResult:
        response = self._responses_create(
            model=self._model,
            input=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": self._build_user_prompt(
                        patient_description=patient_description,
                        task_title=task_title,
                        task_details=task_details,
                    ),
                },
            ],
            # Fallback: JSON mode. Model returns valid JSON, then we validate locally.
            text={"format": {"type": "json_object"}},
        )
        return self._parse_response_payload(response)

    def estimate_priority(
        self,
        patient_description: str,
        task_title: str,
        task_details: str | None,
    ) -> LlmPriorityResult:
        try:
            return self._request_structured_output(
                patient_description=patient_description,
                task_title=task_title,
                task_details=task_details,
            )
        except BadRequestError as exc:
            # Some model snapshots/configurations may not support json_schema strict mode.
            logger.warning("Structured output rejected; falling back to JSON mode", exc_info=exc)
        except (LlmServiceError, APIError, ValueError, json.JSONDecodeError) as exc:
            logger.warning("Structured output parsing failed; trying JSON mode", exc_info=exc)

        try:
            return self._request_json_mode(
                patient_description=patient_description,
                task_title=task_title,
                task_details=task_details,
            )
        except Exception as exc:  # noqa: BLE001
            logger.error("OpenAI call failed; using fallback priority", exc_info=exc)
            return LlmPriorityResult(priority=3, confidence=0.0, reason="fallback")


@lru_cache(maxsize=8)
def _build_openai_client(api_key: str) -> OpenAI:
    return OpenAI(api_key=api_key)


def get_openai_planner_client() -> OpenAIPlannerClient:
    resolved_settings = get_settings()
    client = _build_openai_client(resolved_settings.openai_api_key)
    return OpenAIPlannerClient(client=client, model=resolved_settings.openai_model)
