from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, File, Header, HTTPException, UploadFile, status

from app.config import get_settings
from app.db.supabase_client import (
    ConflictError,
    NotFoundError,
    UpstreamServiceError,
    ValidationError,
    get_repository,
    get_supabase_client,
)
from app.intake_voice.schemas import (
    VoiceConfirmRequest,
    VoiceConfirmResponse,
    VoiceFinalizeRequest,
    VoiceIntakeSessionCreateRequest,
    VoiceIntakeSessionCreateResponse,
    VoiceIntakeSessionListResponse,
    VoicePendingReviewPayload,
    VoiceTranscriptionResponse,
    VoiceTurnRequest,
    VoiceTurnResponse,
)
from app.intake_voice.service import VoiceIntakeService
from app.llm.openai_client import OpenAIPlannerClient, get_openai_planner_client
from app.services.planner import PlannerService
from app.services.preferences_service import PreferencesService, get_preferences_service

router = APIRouter(prefix="/voice-intake", tags=["voice-intake"])


def get_voice_intake_service(
    repository=Depends(get_repository),
    planner_llm_client: OpenAIPlannerClient = Depends(get_openai_planner_client),
    preferences_service: PreferencesService = Depends(get_preferences_service),
) -> VoiceIntakeService:
    planner_service = PlannerService(
        repository=repository,
        llm_client=planner_llm_client,
        preferences_service=preferences_service,
    )
    return VoiceIntakeService(
        repository=repository,
        supabase_client=get_supabase_client(),
        planner_llm_client=planner_llm_client,
        planner_service=planner_service,
        settings=get_settings(),
    )


@router.post("/sessions", response_model=VoiceIntakeSessionCreateResponse, status_code=status.HTTP_201_CREATED)
def create_voice_intake_session(
    payload: VoiceIntakeSessionCreateRequest,
    x_doctor_id: str | None = Header(default=None, alias="X-Doctor-Id"),
    service: VoiceIntakeService = Depends(get_voice_intake_service),
) -> VoiceIntakeSessionCreateResponse:
    try:
        return service.create_session(doctor_id=x_doctor_id, language=payload.language)
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.get("/sessions", response_model=VoiceIntakeSessionListResponse)
def list_pending_reviews(
    x_doctor_id: str | None = Header(default=None, alias="X-Doctor-Id"),
    service: VoiceIntakeService = Depends(get_voice_intake_service),
) -> VoiceIntakeSessionListResponse:
    try:
        return service.list_pending_reviews(doctor_id=x_doctor_id)
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.post("/sessions/{session_id}/transcribe", response_model=VoiceTranscriptionResponse)
async def transcribe_voice_segment(
    session_id: UUID,
    audio_file: UploadFile = File(...),
    service: VoiceIntakeService = Depends(get_voice_intake_service),
) -> VoiceTranscriptionResponse:
    try:
        data = await audio_file.read()
        if not data:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Audio file is empty")

        return service.transcribe_audio(
            session_id=session_id,
            audio_bytes=data,
            filename=audio_file.filename or "segment.webm",
            content_type=audio_file.content_type or "audio/webm",
        )
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.post("/sessions/{session_id}/turn", response_model=VoiceTurnResponse)
def submit_voice_turn(
    session_id: UUID,
    payload: VoiceTurnRequest,
    service: VoiceIntakeService = Depends(get_voice_intake_service),
) -> VoiceTurnResponse:
    try:
        return service.process_turn(session_id=session_id, payload=payload)
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.post("/sessions/{session_id}/finalize", response_model=VoicePendingReviewPayload)
def finalize_voice_intake(
    session_id: UUID,
    payload: VoiceFinalizeRequest,
    service: VoiceIntakeService = Depends(get_voice_intake_service),
) -> VoicePendingReviewPayload:
    try:
        return service.finalize_session(session_id=session_id, payload=payload)
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.post("/sessions/{session_id}/confirm", response_model=VoiceConfirmResponse)
def confirm_voice_intake(
    session_id: UUID,
    payload: VoiceConfirmRequest,
    service: VoiceIntakeService = Depends(get_voice_intake_service),
) -> VoiceConfirmResponse:
    try:
        return service.confirm_session(session_id=session_id, payload=payload)
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except ConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except UpstreamServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
