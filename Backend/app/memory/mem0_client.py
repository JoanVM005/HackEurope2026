from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any

from app.config import get_settings
from app.models.preferences import PlannerPreferences

try:
    from mem0 import MemoryClient
except Exception:  # noqa: BLE001
    MemoryClient = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)
PREFERENCE_MEMORY_KIND = "planner_preferences_v1"


class Mem0Error(Exception):
    """Raised when Mem0 cannot process a request."""


class Mem0Client:
    def __init__(self, client: Any):
        self._client = client

    @staticmethod
    def _as_memories(raw: Any) -> list[dict[str, Any]]:
        if isinstance(raw, list):
            return [item for item in raw if isinstance(item, dict)]
        if isinstance(raw, dict):
            candidates = raw.get("results") or raw.get("memories") or raw.get("data") or []
            if isinstance(candidates, list):
                return [item for item in candidates if isinstance(item, dict)]
        return []

    @staticmethod
    def _parse_timestamp(raw_item: dict[str, Any]) -> datetime:
        for key in ("updated_at", "created_at", "createdAt", "updatedAt"):
            value = raw_item.get(key)
            if isinstance(value, str):
                try:
                    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                    if parsed.tzinfo is None:
                        return parsed.replace(tzinfo=timezone.utc)
                    return parsed.astimezone(timezone.utc)
                except ValueError:
                    continue
        return datetime.min.replace(tzinfo=timezone.utc)

    @staticmethod
    def _extract_prefs(raw_item: dict[str, Any]) -> PlannerPreferences | None:
        metadata = raw_item.get("metadata") if isinstance(raw_item.get("metadata"), dict) else {}
        if metadata.get("kind") != PREFERENCE_MEMORY_KIND:
            return None

        raw_preferences = metadata.get("preferences")
        if isinstance(raw_preferences, dict):
            return PlannerPreferences.model_validate(raw_preferences)

        for field_name in ("memory", "text", "content"):
            content = raw_item.get(field_name)
            if not isinstance(content, str):
                continue
            try:
                payload = json.loads(content)
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict):
                return PlannerPreferences.model_validate(payload)

        return None

    def get_preferences(self, doctor_id: str) -> PlannerPreferences | None:
        try:
            try:
                raw = self._client.get_all(
                    filters={"user_id": doctor_id},
                    version="v2",
                    page_size=200,
                )
            except TypeError:
                raw = self._client.get_all(user_id=doctor_id)
        except Exception as exc:  # noqa: BLE001
            raise Mem0Error("failed to fetch preferences from Mem0") from exc

        memories = self._as_memories(raw)
        latest: PlannerPreferences | None = None
        latest_time = datetime.min.replace(tzinfo=timezone.utc)
        for item in memories:
            try:
                parsed = self._extract_prefs(item)
            except Exception:  # noqa: BLE001
                continue
            if parsed is None:
                continue
            parsed_time = self._parse_timestamp(item)
            if parsed_time >= latest_time:
                latest = parsed
                latest_time = parsed_time

        return latest

    def upsert_preferences(self, doctor_id: str, prefs: PlannerPreferences) -> PlannerPreferences:
        payload = prefs.model_dump(mode="json")
        metadata: dict[str, Any] = {
            "kind": PREFERENCE_MEMORY_KIND,
            "preferences": payload,
        }

        settings = get_settings()
        if settings.mem0_project_id:
            metadata["project_id"] = settings.mem0_project_id

        try:
            try:
                self._client.add(
                    messages=[
                        {"role": "system", "content": "planner preferences snapshot"},
                        {"role": "user", "content": json.dumps(payload, ensure_ascii=True)},
                    ],
                    user_id=doctor_id,
                    metadata=metadata,
                    infer=False,
                    version="v2",
                )
            except TypeError:
                self._client.add(
                    json.dumps(payload, ensure_ascii=True),
                    user_id=doctor_id,
                    metadata=metadata,
                    infer=False,
                    version="v2",
                )
        except Exception as exc:  # noqa: BLE001
            raise Mem0Error("failed to persist preferences in Mem0") from exc

        return prefs

    def add_feedback(self, doctor_id: str, feedback_event: dict[str, Any]) -> None:
        metadata: dict[str, Any] = {
            "kind": "planner_feedback_v1",
            "event": feedback_event,
        }
        try:
            self._client.add(
                json.dumps(feedback_event, ensure_ascii=True),
                user_id=doctor_id,
                metadata=metadata,
                infer=False,
                version="v2",
            )
        except Exception as exc:  # noqa: BLE001
            raise Mem0Error("failed to store feedback in Mem0") from exc


@lru_cache(maxsize=2)
def _build_mem0_client(api_key: str, org_id: str | None) -> Mem0Client:
    if MemoryClient is None:
        raise Mem0Error("mem0 package is not installed")

    kwargs: dict[str, Any] = {"api_key": api_key}
    if org_id:
        kwargs["org_id"] = org_id

    return Mem0Client(client=MemoryClient(**kwargs))


def get_mem0_client() -> Mem0Client | None:
    settings = get_settings()
    if not settings.mem0_api_key:
        logger.warning("MEM0_API_KEY is not configured; planner preferences will fallback to defaults")
        return None

    try:
        return _build_mem0_client(settings.mem0_api_key, settings.mem0_org_id)
    except Mem0Error:
        raise
    except Exception as exc:  # noqa: BLE001
        raise Mem0Error("failed to initialize Mem0 client") from exc
