export type VoiceIntakeStatus =
  | 'collecting'
  | 'confirming'
  | 'complete'
  | 'pending_review'
  | 'confirmed'
  | 'discarded'
  | 'error'

export type VoiceTurnSource = 'voice' | 'text_fallback'

export interface VoiceSlots {
  first_name: string | null
  last_name: string | null
  description: string | null
  time_preferences: string | null
}

export interface VoiceSessionCreateResponse {
  session_id: string
  status: VoiceIntakeStatus
  updated_slots: VoiceSlots
  next_question: string
  warnings: string[]
}

export interface VoiceTurnResponse {
  session_id: string
  status: VoiceIntakeStatus
  updated_slots: VoiceSlots
  slot_confidence: Record<string, number>
  missing_slots: string[]
  next_question: string
  partial_summary: string
  warnings: string[]
  needs_follow_up: boolean
}

export interface VoiceTranscriptionResponse {
  transcript: string
  confidence: number | null
  provider: string
  warnings: string[]
}

export interface VoiceTaskSuggestions {
  suggested_task_definition_ids: string[]
  suggested_task_names: string[]
  warnings: string[]
}

export interface VoicePrioritySuggestion {
  suggested_priority: number
  confidence: number
  model_reason: string
}

export interface VoicePendingReviewPayload {
  session_id: string
  status: VoiceIntakeStatus
  transcript: {
    pdf_path: string
    pdf_url: string
    turn_count: number
  }
  extracted_data: VoiceSlots
  task_suggestions: VoiceTaskSuggestions
  priority_suggestion: VoicePrioritySuggestion
}

export interface VoicePendingReviewSummary {
  session_id: string
  status: VoiceIntakeStatus
  created_at: string
  updated_at: string
  extracted_data: VoiceSlots
  suggested_task_names: string[]
  priority_suggested: number | null
  priority_confidence: number | null
  priority_reason: string | null
  pdf_url: string | null
  warnings: string[]
}

export interface VoiceConfirmPayload {
  first_name: string
  last_name: string
  description: string
  time_preferences: string | null
  admitted_at: string
  priority_final: number
  priority_suggested: number
  confidence: number
  model_reason: string
  override_reason: string | null
  selected_task_definition_ids: string[]
}

export interface VoiceConfirmResponse {
  patient: {
    externalPatientId: number
    firstName: string
    lastName: string
  }
  tasks: Array<{
    id: string
    taskName: string
  }>
  session_status: VoiceIntakeStatus
  warnings: string[]
}
