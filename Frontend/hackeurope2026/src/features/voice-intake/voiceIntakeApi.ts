import { apiRequest } from '../../lib/apiClient'
import type {
  VoiceConfirmPayload,
  VoiceConfirmResponse,
  VoicePendingReviewPayload,
  VoicePendingReviewSummary,
  VoiceSessionCreateResponse,
  VoiceTranscriptionResponse,
  VoiceTurnResponse,
} from './types'

interface VoiceSessionListResponseDto {
  sessions: VoicePendingReviewSummary[]
}

interface VoiceConfirmResponseDto {
  patient: {
    patient_id: number
    first_name: string
    last_name: string
  }
  tasks: Array<{
    id: string
    task_name: string
  }>
  session_status: string
  warnings: string[]
}

export async function createVoiceSession(language = 'en'): Promise<VoiceSessionCreateResponse> {
  return apiRequest<VoiceSessionCreateResponse>('/voice-intake/sessions', {
    method: 'POST',
    body: JSON.stringify({ language }),
  })
}

export async function listPendingReviewSessions(): Promise<VoicePendingReviewSummary[]> {
  const response = await apiRequest<VoiceSessionListResponseDto>('/voice-intake/sessions')
  return response.sessions
}

export async function transcribeVoiceSegment(sessionId: string, audioBlob: Blob): Promise<VoiceTranscriptionResponse> {
  const formData = new FormData()
  formData.append('audio_file', audioBlob, 'segment.webm')

  return apiRequest<VoiceTranscriptionResponse>(`/voice-intake/sessions/${encodeURIComponent(sessionId)}/transcribe`, {
    method: 'POST',
    body: formData,
  })
}

export async function submitVoiceTurn(
  sessionId: string,
  payload: {
    transcript_chunk: string
    source: 'voice' | 'text_fallback'
    stt_confidence?: number | null
  },
): Promise<VoiceTurnResponse> {
  return apiRequest<VoiceTurnResponse>(`/voice-intake/sessions/${encodeURIComponent(sessionId)}/turn`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function finalizeVoiceSession(sessionId: string): Promise<VoicePendingReviewPayload> {
  return apiRequest<VoicePendingReviewPayload>(`/voice-intake/sessions/${encodeURIComponent(sessionId)}/finalize`, {
    method: 'POST',
    body: JSON.stringify({
      final_confirmation: 'ui_confirm',
      regenerate_pdf: false,
    }),
  })
}

export async function confirmVoiceSession(sessionId: string, payload: VoiceConfirmPayload): Promise<VoiceConfirmResponse> {
  const response = await apiRequest<VoiceConfirmResponseDto>(`/voice-intake/sessions/${encodeURIComponent(sessionId)}/confirm`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })

  return {
    patient: {
      externalPatientId: response.patient.patient_id,
      firstName: response.patient.first_name,
      lastName: response.patient.last_name,
    },
    tasks: response.tasks.map((task) => ({
      id: task.id,
      taskName: task.task_name,
    })),
    session_status: response.session_status as VoiceConfirmResponse['session_status'],
    warnings: response.warnings,
  }
}
