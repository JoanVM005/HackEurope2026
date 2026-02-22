from __future__ import annotations

from dataclasses import dataclass

import httpx


class TranscriptionError(Exception):
    """Raised when speech-to-text provider fails."""


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    confidence: float | None


class ElevenLabsTranscriptionClient:
    BASE_URL = "https://api.elevenlabs.io/v1/speech-to-text"

    def __init__(self, api_key: str, model_id: str = "scribe_v1", timeout_seconds: float = 30.0):
        self._api_key = api_key
        self._model_id = model_id
        self._timeout_seconds = timeout_seconds

    def transcribe(
        self,
        audio_bytes: bytes,
        filename: str,
        content_type: str,
    ) -> TranscriptionResult:
        files = {
            "file": (filename, audio_bytes, content_type),
        }
        data = {
            "model_id": self._model_id,
        }

        headers = {
            "xi-api-key": self._api_key,
        }

        try:
            response = httpx.post(
                self.BASE_URL,
                params={"enable_logging": "true"},
                headers=headers,
                data=data,
                files=files,
                timeout=self._timeout_seconds,
            )
        except httpx.HTTPError as exc:
            raise TranscriptionError("Failed to reach ElevenLabs STT") from exc

        if response.status_code >= 400:
            detail = response.text.strip() or f"HTTP {response.status_code}"
            raise TranscriptionError(f"ElevenLabs STT failed: {detail}")

        payload = response.json()
        transcript = str(payload.get("text") or "").strip()

        # Multi-channel fallback shape.
        if not transcript and isinstance(payload.get("transcripts"), list):
            parts = [str(item.get("text") or "").strip() for item in payload["transcripts"] if isinstance(item, dict)]
            transcript = " ".join(part for part in parts if part).strip()

        if not transcript:
            raise TranscriptionError("ElevenLabs STT returned empty transcript")

        confidence = payload.get("language_probability")
        if isinstance(confidence, (int, float)):
            normalized_confidence = max(0.0, min(float(confidence), 1.0))
        else:
            normalized_confidence = None

        return TranscriptionResult(text=transcript, confidence=normalized_confidence)
