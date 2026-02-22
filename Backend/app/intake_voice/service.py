from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

import httpx
from openai import APIConnectionError, APIError, APITimeoutError, BadRequestError, OpenAI, RateLimitError
from supabase import Client
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from app.config import Settings, get_settings
from app.db.supabase_client import (
    ConflictError,
    NotFoundError,
    SupabaseRepository,
    UpstreamServiceError,
    ValidationError,
)
from app.intake_voice.prompts import (
    CONFIRM_NO_TOKENS,
    CONFIRM_YES_TOKENS,
    SLOT_EXTRACTION_SYSTEM_PROMPT,
    TASK_SUGGESTION_SYSTEM_PROMPT,
)
from app.intake_voice.schemas import (
    VoiceConfirmRequest,
    VoiceConfirmResponse,
    VoiceFinalizeRequest,
    VoiceIntakeSessionCreateResponse,
    VoiceIntakeSessionListResponse,
    VoiceIntakeSessionSummary,
    VoiceIntakeSlots,
    VoiceIntakeStatus,
    VoicePendingReviewPayload,
    VoicePrioritySuggestion,
    VoiceTaskSuggestions,
    VoiceTranscriptArtifact,
    VoiceTranscriptionResponse,
    VoiceTurnRequest,
    VoiceTurnResponse,
)
from app.intake_voice.state_machine import IntakeStateMachine, REQUIRED_SLOTS
from app.llm.openai_client import OpenAIPlannerClient
from app.models.schemas import PatientCreate, PatientTaskAssignCreate
from app.pdf.transcript_pdf_service import TranscriptPdfService
from app.services.planner import PlannerService, PlannerValidationError
from app.transcription.elevenlabs_client import ElevenLabsTranscriptionClient, TranscriptionError

logger = logging.getLogger(__name__)

SLOT_EXTRACTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "first_name": {"type": ["string", "null"], "maxLength": 100},
        "last_name": {"type": ["string", "null"], "maxLength": 100},
        "description": {"type": ["string", "null"], "maxLength": 2000},
        "time_preferences": {"type": ["string", "null"], "maxLength": 1000},
        "slot_confidence": {
            "type": "object",
            "properties": {
                "first_name": {"type": "number", "minimum": 0, "maximum": 1},
                "last_name": {"type": "number", "minimum": 0, "maximum": 1},
                "description": {"type": "number", "minimum": 0, "maximum": 1},
                "time_preferences": {"type": "number", "minimum": 0, "maximum": 1},
            },
            "required": ["first_name", "last_name", "description", "time_preferences"],
            "additionalProperties": False,
        },
        "intent": {
            "type": "string",
            "enum": ["provide_info", "confirm_yes", "confirm_no", "unknown"],
        },
        "needs_follow_up": {"type": "boolean"},
        "follow_up_for": {
            "type": "array",
            "items": {
                "type": "string",
                "enum": ["first_name", "last_name", "description", "time_preferences"],
            },
        },
    },
    "required": [
        "first_name",
        "last_name",
        "description",
        "time_preferences",
        "slot_confidence",
        "intent",
        "needs_follow_up",
        "follow_up_for",
    ],
    "additionalProperties": False,
}


class VoiceIntakeServiceError(Exception):
    """Base voice intake service error."""


class VoiceIntakeTransientError(VoiceIntakeServiceError):
    """Retryable external dependency failure."""


class VoiceIntakeService:
    def __init__(
        self,
        repository: SupabaseRepository,
        supabase_client: Client,
        planner_llm_client: OpenAIPlannerClient,
        planner_service: PlannerService | None = None,
        settings: Settings | None = None,
    ):
        self._repository = repository
        self._client = supabase_client
        self._planner_llm_client = planner_llm_client
        self._planner_service = planner_service
        self._settings = settings or get_settings()
        self._state_machine = IntakeStateMachine()
        self._openai = OpenAI(api_key=self._settings.openai_api_key)
        self._pdf_service = TranscriptPdfService()
        self._stt_client: ElevenLabsTranscriptionClient | None = None
        if self._settings.elevenlabs_api_key:
            self._stt_client = ElevenLabsTranscriptionClient(
                api_key=self._settings.elevenlabs_api_key,
                model_id=self._settings.elevenlabs_stt_model,
            )

    @retry(
        retry=retry_if_exception_type(VoiceIntakeTransientError),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=0.5, min=0.5, max=4),
        reraise=True,
    )
    def _responses_create(self, **kwargs: Any) -> Any:
        try:
            return self._openai.responses.create(**kwargs)
        except (RateLimitError, APITimeoutError, APIConnectionError) as exc:
            raise VoiceIntakeTransientError("Transient OpenAI error") from exc
        except APIError as exc:
            if getattr(exc, "status_code", None) and int(exc.status_code) >= 500:
                raise VoiceIntakeTransientError("OpenAI 5xx error") from exc
            raise

    @staticmethod
    def _normalize_slot_value(value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = " ".join(str(value).split()).strip()
        return cleaned or None

    def _row_to_slots(self, row: dict[str, Any]) -> VoiceIntakeSlots:
        slots_raw = row.get("slots") or {}
        if not isinstance(slots_raw, dict):
            slots_raw = {}
        return VoiceIntakeSlots.model_validate(
            {
                "first_name": slots_raw.get("first_name"),
                "last_name": slots_raw.get("last_name"),
                "description": slots_raw.get("description"),
                "time_preferences": slots_raw.get("time_preferences"),
            }
        )

    @staticmethod
    def _row_to_slot_confidence(row: dict[str, Any]) -> dict[str, float]:
        raw = row.get("slot_confidence") or {}
        if not isinstance(raw, dict):
            raw = {}

        confidence: dict[str, float] = {}
        for slot in REQUIRED_SLOTS:
            value = raw.get(slot)
            if isinstance(value, (int, float)):
                confidence[slot] = max(0.0, min(float(value), 1.0))
            else:
                confidence[slot] = 0.0
        return confidence

    @staticmethod
    def _row_to_warnings(row: dict[str, Any]) -> list[str]:
        raw = row.get("warnings")
        if not isinstance(raw, list):
            return []
        return [str(item) for item in raw if str(item).strip()]

    def _get_session_row(self, session_id: UUID) -> dict[str, Any]:
        try:
            response = (
                self._client.table("voice_intake_sessions")
                .select("*")
                .eq("id", str(session_id))
                .limit(1)
                .execute()
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Failed to load voice intake session")
            raise UpstreamServiceError("Failed to load voice intake session") from exc

        rows = response.data or []
        if not rows:
            raise NotFoundError(f"Voice intake session '{session_id}' not found")

        return dict(rows[0])

    def _update_session(self, session_id: UUID, payload: dict[str, Any]) -> None:
        if not payload:
            return
        try:
            (
                self._client.table("voice_intake_sessions")
                .update(payload)
                .eq("id", str(session_id))
                .execute()
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Failed to update voice intake session")
            raise UpstreamServiceError("Failed to update voice intake session") from exc

    def _next_turn_index(self, session_id: UUID) -> int:
        response = (
            self._client.table("voice_intake_turns")
            .select("turn_index")
            .eq("session_id", str(session_id))
            .order("turn_index", desc=True)
            .limit(1)
            .execute()
        )
        rows = response.data or []
        if not rows:
            return 0
        return int(rows[0]["turn_index"]) + 1

    def _add_turn(
        self,
        session_id: UUID,
        speaker: str,
        content: str,
        source: str,
        stt_confidence: float | None = None,
    ) -> None:
        if not content.strip():
            return

        body = {
            "session_id": str(session_id),
            "turn_index": self._next_turn_index(session_id),
            "speaker": speaker,
            "content": content.strip(),
            "source": source,
            "stt_confidence": stt_confidence,
        }
        try:
            self._client.table("voice_intake_turns").insert(body).execute()
        except Exception as exc:  # noqa: BLE001
            logger.exception("Failed to add voice intake turn")
            raise UpstreamServiceError("Failed to add voice intake turn") from exc

    def _list_turns(self, session_id: UUID) -> list[dict[str, str]]:
        try:
            response = (
                self._client.table("voice_intake_turns")
                .select("speaker,content,source,created_at")
                .eq("session_id", str(session_id))
                .order("turn_index", desc=False)
                .execute()
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Failed to list voice intake turns")
            raise UpstreamServiceError("Failed to list voice intake turns") from exc

        turns: list[dict[str, str]] = []
        for row in response.data or []:
            turns.append(
                {
                    "speaker": str(row.get("speaker") or "unknown"),
                    "content": str(row.get("content") or ""),
                    "source": str(row.get("source") or "unknown"),
                }
            )
        return turns

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
            raise ValueError("No JSON object found")
        data = json.loads(match.group(0))
        if not isinstance(data, dict):
            raise ValueError("Output is not a JSON object")
        return data

    def _extract_slots_with_llm(
        self,
        transcript_chunk: str,
        current_slots: VoiceIntakeSlots,
    ) -> dict[str, Any]:
        user_prompt = (
            "Current known slots (JSON): "
            f"{json.dumps(current_slots.model_dump(mode='json'), separators=(',', ':'))}\n"
            f"Latest doctor utterance: {transcript_chunk}\n"
            "Extract only what can be confirmed from latest utterance."
        )

        try:
            response = self._responses_create(
                model=self._settings.openai_model,
                input=[
                    {"role": "system", "content": SLOT_EXTRACTION_SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
                text={
                    "format": {
                        "type": "json_schema",
                        "name": "voice_intake_slot_extraction",
                        "schema": SLOT_EXTRACTION_SCHEMA,
                        "strict": True,
                    }
                },
            )
            parsed = self._extract_parsed_json(response)
            if not isinstance(parsed, dict):
                parsed = self._safe_json_loads(self._extract_output_text(response))
            return parsed
        except BadRequestError as exc:
            logger.warning("Structured extraction rejected, trying JSON mode", exc_info=exc)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Structured extraction failed, trying JSON mode", exc_info=exc)

        try:
            response = self._responses_create(
                model=self._settings.openai_model,
                input=[
                    {"role": "system", "content": SLOT_EXTRACTION_SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
                text={"format": {"type": "json_object"}},
            )
            parsed = self._extract_parsed_json(response)
            if not isinstance(parsed, dict):
                parsed = self._safe_json_loads(self._extract_output_text(response))
            return parsed
        except Exception as exc:  # noqa: BLE001
            logger.warning("Slot extraction fallback failed", exc_info=exc)

        lowered = transcript_chunk.lower()
        intent = "unknown"
        if any(token in lowered for token in CONFIRM_YES_TOKENS):
            intent = "confirm_yes"
        elif any(token in lowered for token in CONFIRM_NO_TOKENS):
            intent = "confirm_no"

        return {
            "first_name": None,
            "last_name": None,
            "description": None,
            "time_preferences": None,
            "slot_confidence": {
                "first_name": 0.0,
                "last_name": 0.0,
                "description": 0.0,
                "time_preferences": 0.0,
            },
            "intent": intent,
            "needs_follow_up": True,
            "follow_up_for": [],
        }

    def _merge_slots(
        self,
        current: VoiceIntakeSlots,
        extracted: dict[str, Any],
        current_confidence: dict[str, float],
    ) -> tuple[VoiceIntakeSlots, dict[str, float]]:
        merged = current.model_dump(mode="json")
        merged_confidence = dict(current_confidence)

        extracted_conf = extracted.get("slot_confidence") if isinstance(extracted.get("slot_confidence"), dict) else {}

        for slot in REQUIRED_SLOTS:
            value = self._normalize_slot_value(extracted.get(slot))
            confidence_value = extracted_conf.get(slot)
            if isinstance(confidence_value, (int, float)):
                merged_confidence[slot] = max(0.0, min(float(confidence_value), 1.0))

            if value:
                merged[slot] = value

        return VoiceIntakeSlots.model_validate(merged), merged_confidence

    def create_session(self, doctor_id: str | None, language: str = "en") -> VoiceIntakeSessionCreateResponse:
        resolved_doctor = doctor_id or self._settings.default_doctor_id
        payload = {
            "doctor_id": resolved_doctor,
            "language": language,
            "status": VoiceIntakeStatus.collecting.value,
            "slots": {},
            "slot_confidence": {},
            "warnings": [],
        }

        try:
            response = self._client.table("voice_intake_sessions").insert(payload).execute()
        except Exception as exc:  # noqa: BLE001
            logger.exception("Failed to create voice intake session")
            raise UpstreamServiceError("Failed to create voice intake session") from exc

        rows = response.data or []
        if not rows:
            raise UpstreamServiceError("Failed to create voice intake session")

        row = dict(rows[0])
        session_id = UUID(str(row["id"]))
        first_question = (
            "Please dictate the full intake in one message: "
            "first name, last name, why the patient needs the test, and preferred time."
        )

        self._add_turn(
            session_id=session_id,
            speaker="assistant",
            content=first_question,
            source="system",
            stt_confidence=None,
        )

        return VoiceIntakeSessionCreateResponse(
            session_id=session_id,
            status=VoiceIntakeStatus.collecting,
            updated_slots=VoiceIntakeSlots(),
            next_question=first_question,
            warnings=[],
        )

    def list_pending_reviews(self, doctor_id: str | None) -> VoiceIntakeSessionListResponse:
        resolved_doctor = doctor_id or self._settings.default_doctor_id
        try:
            response = (
                self._client.table("voice_intake_sessions")
                .select("id,status,slots,pending_review_payload,pdf_url,warnings,created_at,updated_at")
                .eq("doctor_id", resolved_doctor)
                .eq("status", VoiceIntakeStatus.pending_review.value)
                .order("updated_at", desc=True)
                .execute()
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Failed to list pending reviews")
            raise UpstreamServiceError("Failed to list pending reviews") from exc

        sessions: list[VoiceIntakeSessionSummary] = []
        for row in response.data or []:
            row_dict = dict(row)
            payload = row_dict.get("pending_review_payload") if isinstance(row_dict.get("pending_review_payload"), dict) else {}
            extracted = payload.get("extracted_data") if isinstance(payload, dict) else {}
            if not isinstance(extracted, dict):
                extracted = row_dict.get("slots") if isinstance(row_dict.get("slots"), dict) else {}

            sessions.append(
                VoiceIntakeSessionSummary(
                    session_id=UUID(str(row_dict["id"])),
                    status=VoiceIntakeStatus(str(row_dict.get("status") or VoiceIntakeStatus.pending_review.value)),
                    created_at=row_dict["created_at"],
                    updated_at=row_dict["updated_at"],
                    extracted_data=VoiceIntakeSlots.model_validate(extracted),
                    suggested_task_names=(
                        payload.get("task_suggestions", {}).get("suggested_task_names", [])
                        if isinstance(payload, dict)
                        else []
                    ),
                    priority_suggested=(
                        payload.get("priority_suggestion", {}).get("suggested_priority")
                        if isinstance(payload, dict)
                        else None
                    ),
                    priority_confidence=(
                        payload.get("priority_suggestion", {}).get("confidence")
                        if isinstance(payload, dict)
                        else None
                    ),
                    priority_reason=(
                        payload.get("priority_suggestion", {}).get("model_reason")
                        if isinstance(payload, dict)
                        else None
                    ),
                    pdf_url=row_dict.get("pdf_url"),
                    warnings=self._row_to_warnings(row_dict),
                )
            )

        return VoiceIntakeSessionListResponse(sessions=sessions)

    def transcribe_audio(
        self,
        session_id: UUID,
        audio_bytes: bytes,
        filename: str,
        content_type: str,
    ) -> VoiceTranscriptionResponse:
        _ = self._get_session_row(session_id)
        if self._stt_client is None:
            raise ValidationError("ELEVENLABS_API_KEY is not configured on backend")

        try:
            result = self._stt_client.transcribe(
                audio_bytes=audio_bytes,
                filename=filename,
                content_type=content_type,
            )
        except TranscriptionError as exc:
            raise UpstreamServiceError(str(exc)) from exc

        return VoiceTranscriptionResponse(
            transcript=result.text,
            confidence=result.confidence,
            provider="elevenlabs",
            warnings=[],
        )

    def process_turn(self, session_id: UUID, payload: VoiceTurnRequest) -> VoiceTurnResponse:
        session_row = self._get_session_row(session_id)
        status = VoiceIntakeStatus(str(session_row.get("status") or VoiceIntakeStatus.collecting.value))

        if status in {
            VoiceIntakeStatus.pending_review,
            VoiceIntakeStatus.confirmed,
            VoiceIntakeStatus.discarded,
        }:
            raise ValidationError(f"Session is not editable in status '{status.value}'")

        slots = self._row_to_slots(session_row)
        slot_confidence = self._row_to_slot_confidence(session_row)
        warnings = self._row_to_warnings(session_row)

        self._add_turn(
            session_id=session_id,
            speaker="doctor",
            content=payload.transcript_chunk,
            source=payload.source,
            stt_confidence=payload.stt_confidence,
        )

        extracted = self._extract_slots_with_llm(payload.transcript_chunk, slots)
        merged_slots, merged_confidence = self._merge_slots(slots, extracted, slot_confidence)

        missing_slots = self._state_machine.missing_slots(merged_slots.model_dump())
        intent = str(extracted.get("intent") or "unknown")
        needs_follow_up = bool(extracted.get("needs_follow_up", False))

        if status == VoiceIntakeStatus.confirming and intent == "confirm_yes":
            next_status = VoiceIntakeStatus.complete
            next_question = "Confirmed. You can now finalize this intake."
            needs_follow_up = False
        elif status == VoiceIntakeStatus.confirming and intent == "confirm_no":
            next_status = VoiceIntakeStatus.collecting
            next_question = "Understood. Which field should I correct?"
            needs_follow_up = True
        else:
            next_prompt = self._state_machine.next_question(
                merged_slots.model_dump(),
                merged_confidence,
            )
            if next_prompt is None:
                next_status = VoiceIntakeStatus.confirming
                next_question = self._state_machine.build_readback(merged_slots.model_dump())
                needs_follow_up = True
            else:
                next_status = VoiceIntakeStatus.collecting
                next_question = next_prompt
                needs_follow_up = True

        partial_summary = (
            f"Captured {len(REQUIRED_SLOTS) - len(missing_slots)}/{len(REQUIRED_SLOTS)} required fields."
        )

        self._update_session(
            session_id,
            {
                "status": next_status.value,
                "slots": merged_slots.model_dump(mode="json"),
                "slot_confidence": merged_confidence,
                "warnings": warnings,
            },
        )

        self._add_turn(
            session_id=session_id,
            speaker="assistant",
            content=next_question,
            source="system",
            stt_confidence=None,
        )

        return VoiceTurnResponse(
            session_id=session_id,
            status=next_status,
            updated_slots=merged_slots,
            slot_confidence=merged_confidence,
            missing_slots=missing_slots,
            next_question=next_question,
            partial_summary=partial_summary,
            warnings=warnings,
            needs_follow_up=needs_follow_up,
        )

    def _build_task_suggestion_schema(self, task_names: list[str]) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "suggested_task_names": {
                    "type": "array",
                    "items": {"type": "string", "enum": task_names},
                    "uniqueItems": True,
                },
                "reason": {"type": "string", "minLength": 1, "maxLength": 200},
            },
            "required": ["suggested_task_names", "reason"],
            "additionalProperties": False,
        }

    def _suggest_task_names(
        self,
        description: str,
        time_preferences: str,
        task_names: list[str],
    ) -> tuple[list[str], list[str]]:
        if not task_names:
            return [], ["Task catalog is empty."]

        schema = self._build_task_suggestion_schema(task_names)
        user_prompt = (
            f"Patient intake description: {description}\n"
            f"Time preference: {time_preferences}\n"
            f"Allowed task names: {', '.join(task_names)}\n"
            "Return only tasks from allowed list."
        )

        try:
            response = self._responses_create(
                model=self._settings.openai_model,
                input=[
                    {"role": "system", "content": TASK_SUGGESTION_SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
                text={
                    "format": {
                        "type": "json_schema",
                        "name": "voice_intake_task_suggestion",
                        "schema": schema,
                        "strict": True,
                    }
                },
            )
            parsed = self._extract_parsed_json(response)
            if not isinstance(parsed, dict):
                parsed = self._safe_json_loads(self._extract_output_text(response))
            raw_names = parsed.get("suggested_task_names")
            if not isinstance(raw_names, list):
                return [], ["Task suggestion output was invalid."]

            selected = [str(name) for name in raw_names if isinstance(name, str) and name in task_names]
            if len(selected) != len(raw_names):
                return selected, ["Some suggested tasks were ignored because they are not in catalog."]
            return selected, []
        except BadRequestError as exc:
            logger.warning("Task suggestion schema rejected", exc_info=exc)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Task suggestion failed", exc_info=exc)

        return [], ["Task suggestion fallback: no tasks selected automatically."]

    def _upload_pdf_to_supabase(self, file_path: str, content: bytes) -> str:
        upload_url = f"{self._settings.supabase_url}/storage/v1/object/{self._settings.voice_transcript_bucket}/{file_path}"
        headers = {
            "Authorization": f"Bearer {self._settings.supabase_key}",
            "apikey": self._settings.supabase_key,
            "x-upsert": "true",
            "Content-Type": "application/pdf",
        }
        try:
            response = httpx.post(upload_url, headers=headers, content=content, timeout=30)
        except httpx.HTTPError as exc:
            raise UpstreamServiceError("Failed to upload transcript PDF") from exc

        if response.status_code >= 400:
            detail = response.text.strip() or f"HTTP {response.status_code}"
            raise UpstreamServiceError(f"Failed to upload transcript PDF: {detail}")

        return (
            f"{self._settings.supabase_url}/storage/v1/object/public/"
            f"{self._settings.voice_transcript_bucket}/{file_path}"
        )

    def finalize_session(
        self,
        session_id: UUID,
        payload: VoiceFinalizeRequest,
    ) -> VoicePendingReviewPayload:
        session_row = self._get_session_row(session_id)
        status = VoiceIntakeStatus(str(session_row.get("status") or VoiceIntakeStatus.collecting.value))

        if status == VoiceIntakeStatus.confirmed:
            raise ValidationError("Session is already confirmed")
        if status in {VoiceIntakeStatus.discarded, VoiceIntakeStatus.error}:
            raise ValidationError(f"Session cannot be finalized from status '{status.value}'")

        slots = self._row_to_slots(session_row)
        missing = self._state_machine.missing_slots(slots.model_dump())
        warnings: list[str] = []
        if missing:
            warnings.append(
                "Finalized with missing required fields: "
                + ", ".join(missing)
                + ". Complete them manually in review before confirm."
            )

        turns = self._list_turns(session_id)
        timestamp = datetime.now(timezone.utc)
        filename = f"voice-intake_{session_id}_{timestamp.strftime('%Y%m%dT%H%M%SZ')}.pdf"
        file_path = (
            f"voice-intake/{session_row.get('doctor_id', self._settings.default_doctor_id)}/"
            f"{timestamp.strftime('%Y/%m')}/{filename}"
        )

        pdf_bytes = self._pdf_service.build_pdf(
            session_id=str(session_id),
            slots=slots,
            turns=turns,
            generated_at=timestamp,
        )
        pdf_url = self._upload_pdf_to_supabase(file_path=file_path, content=pdf_bytes)

        task_definitions = self._repository.list_task_definitions()
        task_name_by_lower = {task.name.lower(): task for task in task_definitions}
        allowed_task_names = [task.name for task in task_definitions]
        suggested_task_names, task_warnings = self._suggest_task_names(
            description=slots.description or "",
            time_preferences=slots.time_preferences or "",
            task_names=allowed_task_names,
        )
        task_warnings = [*warnings, *task_warnings]

        selected_ids = []
        for task_name in suggested_task_names:
            task = task_name_by_lower.get(task_name.lower())
            if task is None:
                task_warnings.append(f"Task '{task_name}' is not in catalog and was ignored.")
                continue
            selected_ids.append(task.id)

        if not (slots.description or "").strip():
            priority = VoicePrioritySuggestion(
                suggested_priority=3,
                confidence=0.0,
                model_reason="defaulted because intake description is missing",
            )
        else:
            llm_priority = self._planner_llm_client.estimate_priority(
                patient_description=slots.description or "",
                task_title="Voice intake priority preview",
                task_details=json.dumps(
                    {
                        "time_preferences": slots.time_preferences,
                        "task_names": suggested_task_names,
                    },
                    separators=(",", ":"),
                    sort_keys=True,
                ),
            )
            priority = VoicePrioritySuggestion(
                suggested_priority=llm_priority.priority,
                confidence=llm_priority.confidence,
                model_reason=llm_priority.reason,
            )

        pending_payload = VoicePendingReviewPayload(
            session_id=session_id,
            status=VoiceIntakeStatus.pending_review,
            transcript=VoiceTranscriptArtifact(
                pdf_path=file_path,
                pdf_url=pdf_url,
                turn_count=len(turns),
            ),
            extracted_data=slots,
            task_suggestions=VoiceTaskSuggestions(
                suggested_task_definition_ids=selected_ids,
                suggested_task_names=suggested_task_names,
                warnings=task_warnings,
            ),
            priority_suggestion=priority,
        )

        self._update_session(
            session_id,
            {
                "status": VoiceIntakeStatus.pending_review.value,
                "pdf_path": file_path,
                "pdf_url": pdf_url,
                "warnings": task_warnings,
                "pending_review_payload": pending_payload.model_dump(mode="json"),
            },
        )

        return pending_payload

    def confirm_session(
        self,
        session_id: UUID,
        payload: VoiceConfirmRequest,
    ) -> VoiceConfirmResponse:
        session_row = self._get_session_row(session_id)
        status = VoiceIntakeStatus(str(session_row.get("status") or VoiceIntakeStatus.collecting.value))
        if status not in {VoiceIntakeStatus.pending_review, VoiceIntakeStatus.complete}:
            raise ValidationError(f"Session must be pending review before confirm. Current: {status.value}")

        admitted_at = payload.admitted_at or datetime.now(timezone.utc)
        suggested = payload.priority_suggested if payload.priority_suggested is not None else payload.priority_final

        created_patient = None
        last_conflict_error: Exception | None = None
        for _ in range(5):
            max_id = max((patient.patient_id for patient in self._repository.list_patients()), default=0)
            candidate_patient_id = max_id + 1
            create_payload = PatientCreate(
                patient_id=candidate_patient_id,
                first_name=payload.first_name,
                last_name=payload.last_name,
                description=payload.description,
                time_preferences=payload.time_preferences,
                conversation_pdf_url=session_row.get("pdf_url"),
                priority_final=payload.priority_final,
                priority_suggested=suggested,
                model_reason=payload.model_reason,
                confidence=payload.confidence,
                override_reason=payload.override_reason,
                admitted_at=admitted_at,
            )
            try:
                created_patient = self._repository.create_patient(create_payload)
                break
            except ConflictError as exc:
                last_conflict_error = exc
                continue

        if created_patient is None:
            raise ConflictError("Failed to allocate a unique patient_id") from last_conflict_error

        created_tasks = []
        warnings: list[str] = []
        for task_definition_id in payload.selected_task_definition_ids:
            try:
                task = self._repository.create_patient_task(
                    created_patient.patient_id,
                    PatientTaskAssignCreate(task_definition_id=task_definition_id),
                )
                created_tasks.append(task)
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"Failed to create task {task_definition_id}: {exc}")

        if created_tasks and self._planner_service is not None:
            doctor_id = str(session_row.get("doctor_id") or self._settings.default_doctor_id)
            try:
                self._planner_service.replan_and_sync(doctor_id=doctor_id)
            except (PlannerValidationError, UpstreamServiceError, ValidationError) as exc:
                warnings.append(f"Schedule replan failed after confirmation: {exc}")

        self._update_session(
            session_id,
            {
                "status": VoiceIntakeStatus.confirmed.value,
                "created_patient_external_id": created_patient.patient_id,
                "created_patient_uuid": str(created_patient.id),
            },
        )

        return VoiceConfirmResponse(
            patient=created_patient,
            tasks=created_tasks,
            session_status=VoiceIntakeStatus.confirmed,
            warnings=warnings,
        )
