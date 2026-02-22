from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, status

from app.models.preferences import PlannerPreferencesUpdate, PreferencesPayloadResponse
from app.services.preferences_service import (
    PreferencesService,
    PreferencesServiceError,
    get_preferences_service,
)

router = APIRouter(prefix="/preferences", tags=["preferences"])


@router.get("", response_model=PreferencesPayloadResponse)
def get_preferences(
    x_doctor_id: str | None = Header(default=None, alias="X-Doctor-Id"),
    service: PreferencesService = Depends(get_preferences_service),
) -> PreferencesPayloadResponse:
    resolution = service.get_preferences(doctor_id=x_doctor_id)
    return service.to_response(resolution)


@router.post("", response_model=PreferencesPayloadResponse)
def upsert_preferences(
    payload: PlannerPreferencesUpdate,
    x_doctor_id: str | None = Header(default=None, alias="X-Doctor-Id"),
    service: PreferencesService = Depends(get_preferences_service),
) -> PreferencesPayloadResponse:
    try:
        resolution = service.upsert_preferences(doctor_id=x_doctor_id, payload=payload)
    except PreferencesServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    return service.to_response(resolution)
