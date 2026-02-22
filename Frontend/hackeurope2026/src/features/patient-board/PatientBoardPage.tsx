import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PatientCard } from './PatientCard'
import { PatientDetailsPopup } from './PatientDetailsPopup'
import LoadingOverlay from '../../components/loading-overlay/LoadingOverlay'
import {
  createPatient,
  createPatientTask,
  deletePatient,
  listPatients,
  listTaskDefinitions,
  previewPatientPriority,
  toIsoFromDatetimeLocal,
} from './patientBoardApi'
import {
  confirmVoiceSession,
  createVoiceSession,
  finalizeVoiceSession,
  listPendingReviewSessions,
  submitVoiceTurn,
  transcribeVoiceSegment,
} from '../voice-intake/voiceIntakeApi'
import type { Clinician } from '../../types/clinician'
import type { PatientCardData, PriorityPreviewData, TaskDefinitionData } from './types'
import type { VoiceConfirmPayload, VoicePendingReviewPayload, VoicePendingReviewSummary, VoiceSlots } from '../voice-intake/types'
import { listCurrentSchedule, replanSchedule } from '../../schedule/scheduleApi'
import './patientBoard.css'

interface PatientBoardPageProps {
  onCreateSchedule?: () => void
  clinicians?: Clinician[]
  onCliniciansChange?: (clinicians: Clinician[]) => void
}

interface ConversationTurn {
  speaker: 'assistant' | 'doctor'
  text: string
}

interface VoiceReviewDraft {
  sessionId: string
  firstName: string
  lastName: string
  description: string
  timePreferences: string
  admittedAtLocal: string
  priorityFinal: number
  prioritySuggested: number
  priorityConfidence: number
  modelReason: string
  overrideReason: string
  selectedTaskDefinitionIds: string[]
  pdfUrl: string | null
}

function nowDatetimeLocal(): string {
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 16)
}

const REPLAN_MAX_ATTEMPTS = 3
const REPLAN_BASE_DELAY_MS = 300

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

async function replanScheduleWithRetry(): Promise<void> {
  let lastError: unknown = null

  for (let attempt = 1; attempt <= REPLAN_MAX_ATTEMPTS; attempt += 1) {
    try {
      await replanSchedule()
      return
    } catch (error) {
      lastError = error
      if (attempt < REPLAN_MAX_ATTEMPTS) {
        await waitMs(REPLAN_BASE_DELAY_MS * attempt)
      }
    }
  }

  if (lastError instanceof Error) {
    throw lastError
  }
  throw new Error('Schedule replan failed.')
}

function sanitizeSlots(slots: VoiceSlots): VoiceSlots {
  return {
    first_name: slots.first_name ?? null,
    last_name: slots.last_name ?? null,
    description: slots.description ?? null,
    time_preferences: slots.time_preferences ?? null,
  }
}

function toSummaryFromFinalize(payload: VoicePendingReviewPayload): VoicePendingReviewSummary {
  const nowIso = new Date().toISOString()
  return {
    session_id: payload.session_id,
    status: payload.status,
    created_at: nowIso,
    updated_at: nowIso,
    extracted_data: sanitizeSlots(payload.extracted_data),
    suggested_task_names: payload.task_suggestions.suggested_task_names,
    priority_suggested: payload.priority_suggestion.suggested_priority,
    priority_confidence: payload.priority_suggestion.confidence,
    priority_reason: payload.priority_suggestion.model_reason,
    pdf_url: payload.transcript.pdf_url,
    warnings: payload.task_suggestions.warnings,
  }
}

export default function PatientBoardPage({ onCreateSchedule }: PatientBoardPageProps) {
  const [patients, setPatients] = useState<PatientCardData[]>([])
  const [taskDefinitions, setTaskDefinitions] = useState<TaskDefinitionData[]>([])
  const [scheduledPatientIds, setScheduledPatientIds] = useState<Set<number>>(new Set())
  const [pendingReviews, setPendingReviews] = useState<VoicePendingReviewSummary[]>([])

  const [intakeMode, setIntakeMode] = useState<'manual' | 'voice'>('manual')

  const [newPatientNumericId, setNewPatientNumericId] = useState('')
  const [newPatientFirstName, setNewPatientFirstName] = useState('')
  const [newPatientLastName, setNewPatientLastName] = useState('')
  const [newPatientDescription, setNewPatientDescription] = useState('')
  const [newPatientTimePreferences, setNewPatientTimePreferences] = useState('')
  const [newPatientAdmissionTimestamp, setNewPatientAdmissionTimestamp] = useState('')
  const [newPatientTaskSelection, setNewPatientTaskSelection] = useState<Record<string, boolean>>({})

  const [voiceSessionId, setVoiceSessionId] = useState<string | null>(null)
  const [voiceStatus, setVoiceStatus] = useState<string>('idle')
  const [voiceSlots, setVoiceSlots] = useState<VoiceSlots>({
    first_name: null,
    last_name: null,
    description: null,
    time_preferences: null,
  })
  const [voiceNextQuestion, setVoiceNextQuestion] = useState('Start a voice session to begin intake.')
  const [voiceConversation, setVoiceConversation] = useState<ConversationTurn[]>([])
  const [voiceFallbackText, setVoiceFallbackText] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [isSendingVoiceTurn, setIsSendingVoiceTurn] = useState(false)
  const [isFinalizingVoice, setIsFinalizingVoice] = useState(false)

  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isCreatingPatient, setIsCreatingPatient] = useState(false)
  const [isPreviewing, setIsPreviewing] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null)
  const [reviewDraft, setReviewDraft] = useState<CreateReviewDraft | null>(null)
  const [reviewPreview, setReviewPreview] = useState<PriorityPreviewData | null>(null)
  const [reviewFinalPriority, setReviewFinalPriority] = useState<number>(3)
  const [reviewOverrideReason, setReviewOverrideReason] = useState('')
  const [reviewError, setReviewError] = useState<string | null>(null)

  const [voiceReviewDraft, setVoiceReviewDraft] = useState<VoiceReviewDraft | null>(null)
  const [voiceReviewError, setVoiceReviewError] = useState<string | null>(null)
  const [isConfirmingVoiceReview, setIsConfirmingVoiceReview] = useState(false)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioChunksRef = useRef<BlobPart[]>([])
  const voiceConversationRef = useRef<HTMLDivElement | null>(null)

  const selectedPatient = useMemo(
    () => patients.find((patient) => patient.id === selectedPatientId) ?? null,
    [patients, selectedPatientId],
  )

  const taskByNameLower = useMemo(() => {
    const map = new Map<string, TaskDefinitionData>()
    for (const task of taskDefinitions) {
      map.set(task.name.toLowerCase(), task)
    }
    return map
  }, [taskDefinitions])

  const scheduledPatients = useMemo(
    () =>
      patients.filter((patient) => {
        const normalizedId = Number(patient.externalPatientId)
        return Number.isFinite(normalizedId) && scheduledPatientIds.has(normalizedId)
      }),
    [patients, scheduledPatientIds],
  )

  const voiceBusy = isTranscribing || isSendingVoiceTurn || isFinalizingVoice || isConfirmingVoiceReview

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setErrorMessage(null)
    try {
      const [loadedPatients, loadedTaskDefinitions, loadedPendingReviews, scheduleItems] = await Promise.all([
        listPatients(),
        listTaskDefinitions(),
        listPendingReviewSessions(),
        listCurrentSchedule(),
      ])

      const nextScheduled = new Set<number>()
      for (const item of scheduleItems) {
        const normalizedId = Number(item.patientExternalId)
        if (Number.isFinite(normalizedId)) {
          nextScheduled.add(normalizedId)
        }
      }

      setPatients(loadedPatients)
      setTaskDefinitions(loadedTaskDefinitions)
      setPendingReviews(loadedPendingReviews)
      setScheduledPatientIds(nextScheduled)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load patients data.'
      setErrorMessage(message)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
    if (!voiceConversationRef.current) return
    voiceConversationRef.current.scrollTop = voiceConversationRef.current.scrollHeight
  }, [voiceConversation])

  const buildCreateDraft = () => {
    const parsedPatientId = Number.parseInt(newPatientNumericId, 10)
    const trimmedFirstName = newPatientFirstName.trim()
    const trimmedLastName = newPatientLastName.trim()
    const trimmedDescription = newPatientDescription.trim()
    const trimmedTimePreferences = newPatientTimePreferences.trim()
    const admittedAt = toIsoFromDatetimeLocal(newPatientAdmissionTimestamp)
    const hasIdConflict = patients.some((patient) => patient.patientId === parsedPatientId)

    if (!Number.isInteger(parsedPatientId) || parsedPatientId < 0) return null
    if (!trimmedFirstName || !trimmedLastName || !trimmedDescription || !admittedAt) return null
    if (hasIdConflict) return null

    const selectedTaskDefinitions = taskDefinitions.filter(
      (taskDefinition) => newPatientTaskSelection[taskDefinition.id],
    )

    return {
      patientId: parsedPatientId,
      firstName: trimmedFirstName,
      lastName: trimmedLastName,
      description: trimmedDescription,
      timePreferences: trimmedTimePreferences,
      admittedAt,
      selectedTaskDefinitions,
    }
  }

  const startPriorityPreview = async () => {
    if (isCreatingPatient || isPreviewing) return

    const draft = buildCreateDraft()
    if (!draft) return

    setErrorMessage(null)
    setNoticeMessage(null)
    setReviewError(null)
    setIsPreviewing(true)

    try {
      const preview = await previewPatientPriority({
        first_name: draft.firstName,
        last_name: draft.lastName,
        description: draft.description,
        time_preferences: draft.timePreferences || null,
        admitted_at: draft.admittedAt,
        task_names: draft.selectedTaskDefinitions.map((task) => task.name),
      })

      setReviewDraft(draft)
      setReviewPreview(preview)
      setReviewFinalPriority(preview.suggestedPriority)
      setReviewOverrideReason('')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to preview priority.'
      setErrorMessage(message)
    } finally {
      setIsPreviewing(false)
    }
  }

  const confirmCreatePatient = async () => {
    if (!reviewDraft || !reviewPreview || isCreatingPatient) return

    const finalPriority = Number(reviewFinalPriority)
    if (!Number.isInteger(finalPriority) || finalPriority < 1 || finalPriority > 5) {
      setReviewError('Priority must be an integer between 1 and 5.')
      return
    }

    if (finalPriority !== reviewPreview.suggestedPriority && reviewOverrideReason.trim().length < 5) {
      setReviewError('Please provide a short justification when overriding priority.')
      return
    }

    setIsCreatingPatient(true)
    setReviewError(null)

    try {
      const createdPatient = await createPatient({
        patient_id: reviewDraft.patientId,
        first_name: reviewDraft.firstName,
        last_name: reviewDraft.lastName,
        description: reviewDraft.description,
        time_preferences: reviewDraft.timePreferences || null,
        priority_final: finalPriority,
        priority_suggested: reviewPreview.suggestedPriority,
        model_reason: reviewPreview.modelReason,
        confidence: reviewPreview.confidence,
        override_reason:
          finalPriority !== reviewPreview.suggestedPriority ? reviewOverrideReason.trim() : null,
        admitted_at: reviewDraft.admittedAt,
      })

      const selectedTaskDefinitions = reviewDraft.selectedTaskDefinitions
      const results = await Promise.allSettled(
        selectedTaskDefinitions.map((taskDefinition) =>
          createPatientTask(createdPatient.externalPatientId, {
            task_definition_id: taskDefinition.id,
            status: 'pending',
          }),
        ),
      )

      const failedTaskNames = results
        .map((result, index) => ({ result, name: selectedTaskDefinitions[index].name }))
        .filter((item) => item.result.status === 'rejected')
        .map((item) => item.name)

      let scheduleRefreshWarning: string | null = null
      if (selectedTaskDefinitions.length > 0) {
        try {
          await replanScheduleWithRetry()
        } catch {
          scheduleRefreshWarning = 'Schedule sync is delayed. Press "Create schedule" to retry.'
        }
      }

      const noticeParts: string[] = []
      if (failedTaskNames.length > 0) {
        noticeParts.push(`Patient created, but some tasks failed: ${failedTaskNames.join(', ')}`)
      } else {
        noticeParts.push('Patient created successfully.')
      }
      if (selectedTaskDefinitions.length === 0) {
        noticeParts.push('No tasks selected, so no schedule was generated.')
      }
      if (scheduleRefreshWarning) {
        noticeParts.push(scheduleRefreshWarning)
      }
      setNoticeMessage(noticeParts.join(' '))

      await loadData()
      setNewPatientTaskSelection({})
      setNewPatientNumericId('')
      setNewPatientFirstName('')
      setNewPatientLastName('')
      setNewPatientDescription('')
      setNewPatientTimePreferences('')
      setNewPatientAdmissionTimestamp('')
      setReviewDraft(null)
      setReviewPreview(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create patient.'
      setErrorMessage(message)
    } finally {
      setIsCreatingPatient(false)
    }
  }

  const toggleNewPatientTask = (taskDefinitionId: string) => {
    setNewPatientTaskSelection((current) => ({
      ...current,
      [taskDefinitionId]: !current[taskDefinitionId],
    }))
  }

  const handleDeletePatient = async (patientExternalId: number) => {
    try {
      await deletePatient(patientExternalId)
      await loadData()
      setSelectedPatientId(null)
      setNoticeMessage('Patient deleted successfully.')
      setErrorMessage(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete patient.'
      setErrorMessage(message)
    }
  }

  const handleSavedFromPopup = async (warningMessage?: string) => {
    await loadData()
    if (warningMessage) {
      setNoticeMessage(warningMessage)
    } else {
      setNoticeMessage('Patient updated successfully.')
    }
    setErrorMessage(null)
  }

  const handleCancelReview = () => {
    setReviewDraft(null)
    setReviewPreview(null)
    setReviewError(null)
  }

  const appendVoiceConversation = useCallback((speaker: ConversationTurn['speaker'], text: string) => {
    if (!text.trim()) return
    setVoiceConversation((current) => [...current, { speaker, text: text.trim() }])
  }, [])

  const startVoiceSession = async () => {
    if (voiceBusy) return
    setErrorMessage(null)
    setNoticeMessage(null)

    try {
      const created = await createVoiceSession('en')
      setVoiceSessionId(created.session_id)
      setVoiceStatus(created.status)
      setVoiceSlots(sanitizeSlots(created.updated_slots))
      setVoiceNextQuestion(created.next_question)
      setVoiceConversation([{ speaker: 'assistant', text: created.next_question }])
      setNoticeMessage('Voice intake session started. Hold SPACE to dictate.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start voice session.'
      setErrorMessage(message)
    }
  }

  const submitVoiceTranscript = useCallback(
    async (transcript: string, source: 'voice' | 'text_fallback', confidence?: number | null) => {
      if (!voiceSessionId) return
      const trimmed = transcript.trim()
      if (!trimmed) return

      setIsSendingVoiceTurn(true)
      setErrorMessage(null)
      appendVoiceConversation('doctor', trimmed)

      try {
        const response = await submitVoiceTurn(voiceSessionId, {
          transcript_chunk: trimmed,
          source,
          stt_confidence: confidence ?? undefined,
        })

        const updatedSlots = sanitizeSlots(response.updated_slots)
        setVoiceStatus(response.status)
        setVoiceSlots(updatedSlots)
        setVoiceNextQuestion(response.next_question)
        appendVoiceConversation('assistant', response.next_question)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to process voice turn.'
        setErrorMessage(message)
      } finally {
        setIsSendingVoiceTurn(false)
      }
    },
    [appendVoiceConversation, voiceSessionId],
  )

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state !== 'recording') return
    recorder.stop()
    setIsRecording(false)
  }, [])

  const startRecording = useCallback(async () => {
    if (!voiceSessionId || voiceBusy || isRecording) return

    setErrorMessage(null)
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone is not supported in this browser.')
      }

      if (!streamRef.current) {
        streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true })
      }

      const recorder = new MediaRecorder(streamRef.current)
      audioChunksRef.current = []

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      recorder.onstop = async () => {
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
        audioChunksRef.current = []
        if (blob.size <= 0 || !voiceSessionId) return

        setIsTranscribing(true)
        try {
          const result = await transcribeVoiceSegment(voiceSessionId, blob)
          await submitVoiceTranscript(result.transcript, 'voice', result.confidence)
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to transcribe audio.'
          setErrorMessage(message)
        } finally {
          setIsTranscribing(false)
        }
      }

      mediaRecorderRef.current = recorder
      recorder.start()
      setIsRecording(true)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not access microphone.'
      setErrorMessage(message)
    }
  }, [voiceBusy, isRecording, voiceSessionId, submitVoiceTranscript])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (intakeMode !== 'voice') return
      if (event.code !== 'Space') return

      const target = event.target as HTMLElement | null
      const isTypingField = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
      if (isTypingField) return

      event.preventDefault()
      if (event.repeat) return
      void startRecording()
    }

    const onKeyUp = (event: KeyboardEvent) => {
      if (intakeMode !== 'voice') return
      if (event.code !== 'Space') return

      const target = event.target as HTMLElement | null
      const isTypingField = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
      if (isTypingField) return

      event.preventDefault()
      stopRecording()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [intakeMode, startRecording, stopRecording])

  useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stop()
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  const submitVoiceFallbackText = async () => {
    if (!voiceFallbackText.trim()) return
    const chunk = voiceFallbackText.trim()
    setVoiceFallbackText('')
    await submitVoiceTranscript(chunk, 'text_fallback', null)
  }

  const finalizeVoiceSessionCurrent = async () => {
    if (!voiceSessionId || voiceBusy) return

    setIsFinalizingVoice(true)
    setErrorMessage(null)
    setNoticeMessage(null)

    try {
      const payload = await finalizeVoiceSession(voiceSessionId)
      const summary = toSummaryFromFinalize(payload)
      setPendingReviews((current) => [summary, ...current.filter((item) => item.session_id !== summary.session_id)])
      setVoiceStatus(payload.status)
      setNoticeMessage('Pending confirmation created from voice intake.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to finalize voice session.'
      setErrorMessage(message)
    } finally {
      setIsFinalizingVoice(false)
    }
  }

  const openPendingReview = (summary: VoicePendingReviewSummary) => {
    const slotData = sanitizeSlots(summary.extracted_data)
    const mappedIds = summary.suggested_task_names
      .map((name) => taskByNameLower.get(name.toLowerCase())?.id)
      .filter((value): value is string => Boolean(value))

    setVoiceReviewDraft({
      sessionId: summary.session_id,
      firstName: slotData.first_name ?? '',
      lastName: slotData.last_name ?? '',
      description: slotData.description ?? '',
      timePreferences: slotData.time_preferences ?? '',
      admittedAtLocal: nowDatetimeLocal(),
      priorityFinal: summary.priority_suggested ?? 3,
      prioritySuggested: summary.priority_suggested ?? 3,
      priorityConfidence: summary.priority_confidence ?? 0,
      modelReason: summary.priority_reason ?? 'No model reason available.',
      overrideReason: '',
      selectedTaskDefinitionIds: mappedIds,
      pdfUrl: summary.pdf_url,
    })
    setVoiceReviewError(null)
  }

  const toggleVoiceReviewTask = (taskId: string) => {
    setVoiceReviewDraft((current) => {
      if (!current) return current
      const exists = current.selectedTaskDefinitionIds.includes(taskId)
      if (exists) {
        return {
          ...current,
          selectedTaskDefinitionIds: current.selectedTaskDefinitionIds.filter((id) => id !== taskId),
        }
      }
      return {
        ...current,
        selectedTaskDefinitionIds: [...current.selectedTaskDefinitionIds, taskId],
      }
    })
  }

  const confirmPendingReview = async () => {
    if (!voiceReviewDraft || voiceBusy) return

    if (
      !voiceReviewDraft.firstName.trim() ||
      !voiceReviewDraft.lastName.trim() ||
      !voiceReviewDraft.description.trim()
    ) {
      setVoiceReviewError('All required fields must be completed before confirming.')
      return
    }

    if (
      voiceReviewDraft.priorityFinal < 1 ||
      voiceReviewDraft.priorityFinal > 5 ||
      !Number.isInteger(voiceReviewDraft.priorityFinal)
    ) {
      setVoiceReviewError('Priority must be an integer between 1 and 5.')
      return
    }

    if (
      voiceReviewDraft.priorityFinal !== voiceReviewDraft.prioritySuggested &&
      voiceReviewDraft.overrideReason.trim().length < 5
    ) {
      setVoiceReviewError('Please provide at least 5 characters in override reason when changing priority.')
      return
    }

    if (voiceReviewDraft.selectedTaskDefinitionIds.length === 0) {
      setVoiceReviewError('Select at least one task before confirming this patient.')
      return
    }

    const admittedAtIso = toIsoFromDatetimeLocal(voiceReviewDraft.admittedAtLocal)
    if (!admittedAtIso) {
      setVoiceReviewError('Admission timestamp is invalid.')
      return
    }

    setIsConfirmingVoiceReview(true)
    setVoiceReviewError(null)

    try {
      const payload: VoiceConfirmPayload = {
        first_name: voiceReviewDraft.firstName.trim(),
        last_name: voiceReviewDraft.lastName.trim(),
        description: voiceReviewDraft.description.trim(),
        time_preferences: voiceReviewDraft.timePreferences.trim() || null,
        admitted_at: admittedAtIso,
        priority_final: voiceReviewDraft.priorityFinal,
        priority_suggested: voiceReviewDraft.prioritySuggested,
        confidence: voiceReviewDraft.priorityConfidence,
        model_reason: voiceReviewDraft.modelReason,
        override_reason:
          voiceReviewDraft.priorityFinal !== voiceReviewDraft.prioritySuggested
            ? voiceReviewDraft.overrideReason.trim()
            : null,
        selected_task_definition_ids: voiceReviewDraft.selectedTaskDefinitionIds,
      }

      const result = await confirmVoiceSession(voiceReviewDraft.sessionId, payload)

      let scheduleRefreshWarning: string | null = null
      try {
        await replanScheduleWithRetry()
      } catch {
        scheduleRefreshWarning = 'Schedule sync is delayed. Press "Create schedule" to retry.'
      }

      const warningParts = [...result.warnings]
      if (scheduleRefreshWarning) {
        warningParts.push(scheduleRefreshWarning)
      }
      const warningSuffix = warningParts.length > 0 ? ` ${warningParts.join(' ')}` : ''

      setNoticeMessage(
        `Patient ${result.patient.firstName} ${result.patient.lastName} created from pending confirmation.${warningSuffix}`,
      )
      setVoiceReviewDraft(null)
      await loadData()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to confirm pending review.'
      setVoiceReviewError(message)
    } finally {
      setIsConfirmingVoiceReview(false)
    }
  }

  return (
    <main className="patient-board">
      <header className="patient-board__hero">
        <h1>Today's Patient Queue</h1>
        <p className="patient-board__subtitle">
          Choose how to intake new patients, then manage confirmed and pending cases below.
        </p>
        {errorMessage ? <p className="patient-board__feedback patient-board__feedback--error">{errorMessage}</p> : null}
        {noticeMessage ? <p className="patient-board__feedback patient-board__feedback--notice">{noticeMessage}</p> : null}

        {onCreateSchedule ? (
          <div className="patient-board__top-actions">
            <button type="button" className="page-action-btn patient-board__create-btn" onClick={onCreateSchedule}>
              Create schedule
            </button>
          </div>
        ) : null}

        <div className="patient-board__mode-tabs" role="tablist" aria-label="Intake mode">
          <button
            type="button"
            role="tab"
            aria-selected={intakeMode === 'manual'}
            className={`patient-board__mode-tab ${intakeMode === 'manual' ? 'patient-board__mode-tab--active' : ''}`}
            onClick={() => setIntakeMode('manual')}
          >
            Add manually
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={intakeMode === 'voice'}
            className={`patient-board__mode-tab ${intakeMode === 'voice' ? 'patient-board__mode-tab--active' : ''}`}
            onClick={() => setIntakeMode('voice')}
          >
            Add by voice
          </button>
        </div>

        {intakeMode === 'manual' ? (
          <form
            className="patient-board__composer"
            onSubmit={(event) => {
              event.preventDefault()
              void startPriorityPreview()
            }}
          >
            <label className="patient-board__input-wrap">
              <span>Patient ID</span>
              <input
                type="number"
                min={0}
                value={newPatientNumericId}
                onChange={(event) => setNewPatientNumericId(event.target.value)}
                placeholder="e.g. 1051"
              />
            </label>

            <label className="patient-board__input-wrap">
              <span>First name</span>
              <input
                type="text"
                value={newPatientFirstName}
                onChange={(event) => setNewPatientFirstName(event.target.value)}
                placeholder="e.g. Nina"
              />
            </label>

            <label className="patient-board__input-wrap">
              <span>Last name</span>
              <input
                type="text"
                value={newPatientLastName}
                onChange={(event) => setNewPatientLastName(event.target.value)}
                placeholder="e.g. Arendt"
              />
            </label>

            <label className="patient-board__input-wrap">
              <span>Admission timestamp</span>
              <input
                type="datetime-local"
                value={newPatientAdmissionTimestamp}
                onChange={(event) => setNewPatientAdmissionTimestamp(event.target.value)}
              />
            </label>

            <label className="patient-board__input-wrap patient-board__input-wrap--description">
              <span>Description</span>
              <input
                type="text"
                value={newPatientDescription}
                onChange={(event) => setNewPatientDescription(event.target.value)}
                placeholder="Reason for patient admission"
              />
            </label>
            <label className="patient-board__input-wrap patient-board__input-wrap--preferences">
              <span>Time preferences</span>
              <input
                type="text"
                value={newPatientTimePreferences}
                onChange={(event) => setNewPatientTimePreferences(event.target.value)}
                placeholder="e.g. prefers mornings, avoid late afternoons"
              />
            </label>

            <fieldset className="patient-board__test-options">
              <legend>Required tasks</legend>
              {taskDefinitions.map((taskDefinition) => (
                <label key={taskDefinition.id}>
                  <input
                    type="checkbox"
                    checked={Boolean(newPatientTaskSelection[taskDefinition.id])}
                    onChange={() => toggleNewPatientTask(taskDefinition.id)}
                  />
                  <span>{taskDefinition.name}</span>
                </label>
              ))}
            </fieldset>

            <button type="submit" className="patient-board__add-btn">
              {isPreviewing ? 'Previewing...' : 'Add patient'}
            </button>
          </form>
        ) : (
          <section className="patient-board__voice-composer" aria-label="Voice intake composer">
            <div className="patient-board__voice-actions">
              <button type="button" className="page-action-btn" onClick={() => void startVoiceSession()} disabled={voiceBusy}>
                {voiceSessionId ? 'Start new voice session' : 'Start voice session'}
              </button>
              <button
                type="button"
                className="page-action-btn page-action-btn--secondary"
                onMouseDown={() => void startRecording()}
                onMouseUp={stopRecording}
                onMouseLeave={stopRecording}
                disabled={!voiceSessionId || voiceBusy}
              >
                {isRecording ? 'Recording...' : 'Hold SPACE to talk'}
              </button>
              <button
                type="button"
                className="page-action-btn"
                onClick={() => void finalizeVoiceSessionCurrent()}
                disabled={!voiceSessionId || voiceBusy}
              >
                {isFinalizingVoice ? 'Finalizing...' : 'Close transcription'}
              </button>
            </div>

            <p className="patient-board__voice-status">
              Status: <strong>{voiceStatus}</strong>
              {isRecording ? ' | Listening...' : ''}
              {isTranscribing ? ' | Transcribing...' : ''}
              {isSendingVoiceTurn ? ' | Processing...' : ''}
            </p>

            <p className="patient-board__voice-question">AI: {voiceNextQuestion}</p>

            <div ref={voiceConversationRef} className="patient-board__voice-conversation" aria-live="polite">
              {voiceConversation.length === 0 ? <p className="patient-board__empty">No voice conversation yet.</p> : null}
              {voiceConversation.map((turn, index) => (
                <p key={`${turn.speaker}-${index}`} className={`patient-board__voice-turn patient-board__voice-turn--${turn.speaker}`}>
                  <span>{turn.speaker === 'assistant' ? 'AI' : 'Doctor'}:</span> {turn.text}
                </p>
              ))}
            </div>

            <div className="patient-board__voice-fallback">
              <label>
                <span>Fallback text input</span>
                <textarea
                  value={voiceFallbackText}
                  onChange={(event) => setVoiceFallbackText(event.target.value)}
                  placeholder="Type the doctor's answer if microphone/STT fails"
                  rows={3}
                />
              </label>
              <button
                type="button"
                className="card-btn card-btn--primary"
                onClick={() => void submitVoiceFallbackText()}
                disabled={voiceBusy || !voiceSessionId}
              >
                Send text turn
              </button>
            </div>

            <ul className="patient-board__voice-slots">
              <li>
                <span>First name</span>
                <strong>{voiceSlots.first_name || '-'}</strong>
              </li>
              <li>
                <span>Last name</span>
                <strong>{voiceSlots.last_name || '-'}</strong>
              </li>
              <li>
                <span>Description</span>
                <strong>{voiceSlots.description || '-'}</strong>
              </li>
              <li>
                <span>Time preference</span>
                <strong>{voiceSlots.time_preferences || '-'}</strong>
              </li>
            </ul>
          </section>
        )}
      </header>

      <section className="patient-board__section" aria-label="Patients with schedule assigned">
        <h2 className="patient-board__section-title">Patients with schedule assigned</h2>
        <div className="patient-board__grid">
          {isLoading ? (
            <p className="patient-board__empty">Loading patients...</p>
          ) : scheduledPatients.length > 0 ? (
            scheduledPatients.map((patient) => <PatientCard key={patient.id} patient={patient} onOpen={setSelectedPatientId} />)
          ) : (
            <p className="patient-board__empty">No patients currently have schedule slots assigned.</p>
          )}
        </div>
      </section>

      <section className="patient-board__section" aria-label="Patients waiting confirmation">
        <h2 className="patient-board__section-title">Patients waiting confirmation</h2>
        <div className="patient-board__pending-grid">
          {pendingReviews.length === 0 ? <p className="patient-board__empty">No pending confirmations.</p> : null}
          {pendingReviews.map((review) => (
            <article key={review.session_id} className="patient-board__pending-card">
              <h3>
                {(review.extracted_data.first_name || '?')} {(review.extracted_data.last_name || '?')}
              </h3>
              <p>
                <strong>Reason:</strong> {review.extracted_data.description || '-'}
              </p>
              <p>
                <strong>Time:</strong> {review.extracted_data.time_preferences || '-'}
              </p>
              <p>
                <strong>Priority:</strong> {review.priority_suggested ?? '-'}
              </p>
              <p>
                <strong>Tasks:</strong> {review.suggested_task_names.length > 0 ? review.suggested_task_names.join(', ') : '-'}
              </p>
              <div className="patient-board__pending-actions">
                {review.pdf_url ? (
                  <a className="card-btn" href={review.pdf_url} target="_blank" rel="noreferrer">
                    View PDF
                  </a>
                ) : null}
                <button type="button" className="card-btn card-btn--primary" onClick={() => openPendingReview(review)}>
                  Review
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <PatientDetailsPopup
        open={selectedPatient !== null}
        patient={selectedPatient}
        taskDefinitions={taskDefinitions}
        onSaved={handleSavedFromPopup}
        onDelete={handleDeletePatient}
        onClose={() => setSelectedPatientId(null)}
      />
      <PriorityReviewModal
        open={Boolean(reviewDraft && reviewPreview)}
        preview={reviewPreview}
        finalPriority={reviewFinalPriority}
        overrideReason={reviewOverrideReason}
        errorMessage={reviewError}
        onPriorityChange={setReviewFinalPriority}
        onOverrideReasonChange={setReviewOverrideReason}
        onCancel={handleCancelReview}
        onConfirm={confirmCreatePatient}
        isSaving={isCreatingPatient}
      />
      <VoicePendingReviewModal
        open={Boolean(voiceReviewDraft)}
        draft={voiceReviewDraft}
        taskDefinitions={taskDefinitions}
        errorMessage={voiceReviewError}
        isSaving={isConfirmingVoiceReview}
        onClose={() => setVoiceReviewDraft(null)}
        onDraftChange={setVoiceReviewDraft}
        onToggleTask={toggleVoiceReviewTask}
        onConfirm={confirmPendingReview}
      />
      <LoadingOverlay
        open={isCreatingPatient || isConfirmingVoiceReview}
        message={isConfirmingVoiceReview ? 'Confirming pending intake...' : 'Creating patient and syncing tasks...'}
        ariaLabel={isConfirmingVoiceReview ? 'Confirming pending intake' : 'Creating patient'}
      />
    </main>
  )
}

interface CreateReviewDraft {
  patientId: number
  firstName: string
  lastName: string
  description: string
  timePreferences: string
  admittedAt: string
  selectedTaskDefinitions: TaskDefinitionData[]
}

interface PriorityReviewModalProps {
  open: boolean
  preview: PriorityPreviewData | null
  finalPriority: number
  overrideReason: string
  errorMessage: string | null
  onPriorityChange: (value: number) => void
  onOverrideReasonChange: (value: string) => void
  onCancel: () => void
  onConfirm: () => void
  isSaving: boolean
}

function PriorityReviewModal({
  open,
  preview,
  finalPriority,
  overrideReason,
  errorMessage,
  onPriorityChange,
  onOverrideReasonChange,
  onCancel,
  onConfirm,
  isSaving,
}: PriorityReviewModalProps) {
  if (!open || !preview) return null

  return (
    <>
      <button type="button" className="priority-review__overlay" aria-label="Close priority review" onClick={onCancel} />
      <section className="priority-review" role="dialog" aria-modal="true" aria-label="Priority review">
        <header className="priority-review__header">
          <h2>Priority review</h2>
          <button type="button" className="priority-review__close" onClick={onCancel} disabled={isSaving}>
            <span aria-hidden>×</span>
          </button>
        </header>
        <p className="priority-review__hint">Confirm the suggested priority or override with a brief justification.</p>
        {errorMessage ? <p className="priority-review__message">{errorMessage}</p> : null}

        <div className="priority-review__grid">
          <label>
            <span>Suggested priority</span>
            <input type="number" value={preview.suggestedPriority} readOnly />
          </label>
          <label>
            <span>Final priority (1-5)</span>
            <input
              type="number"
              min={1}
              max={5}
              step={1}
              value={finalPriority}
              onChange={(event) => onPriorityChange(Number(event.target.value))}
            />
          </label>
        </div>

        <div className="priority-review__reason">
          <span>LLM justification</span>
          <p>{preview.modelReason}</p>
        </div>

        <label className="priority-review__override">
          <span>Doctor justification</span>
          <input
            type="text"
            value={overrideReason}
            onChange={(event) => onOverrideReasonChange(event.target.value)}
            placeholder="Briefly explain why you changed the priority"
          />
        </label>

        <footer className="priority-review__actions">
          <button type="button" className="card-btn" onClick={onCancel} disabled={isSaving}>
            Cancel
          </button>
          <button type="button" className="card-btn card-btn--primary" onClick={onConfirm} disabled={isSaving}>
            Accept & Save
          </button>
        </footer>
      </section>
    </>
  )
}

interface VoicePendingReviewModalProps {
  open: boolean
  draft: VoiceReviewDraft | null
  taskDefinitions: TaskDefinitionData[]
  errorMessage: string | null
  isSaving: boolean
  onClose: () => void
  onDraftChange: (value: VoiceReviewDraft | null) => void
  onToggleTask: (taskId: string) => void
  onConfirm: () => void
}

function VoicePendingReviewModal({
  open,
  draft,
  taskDefinitions,
  errorMessage,
  isSaving,
  onClose,
  onDraftChange,
  onToggleTask,
  onConfirm,
}: VoicePendingReviewModalProps) {
  if (!open || !draft) return null

  return (
    <>
      <button type="button" className="priority-review__overlay" aria-label="Close pending review" onClick={onClose} />
      <section className="priority-review" role="dialog" aria-modal="true" aria-label="Pending review">
        <header className="priority-review__header">
          <h2>Pending confirmation</h2>
          <button type="button" className="priority-review__close" onClick={onClose} disabled={isSaving}>
            <span aria-hidden>×</span>
          </button>
        </header>
        <p className="priority-review__hint">Complete/edit fields and confirm to create the patient.</p>
        {errorMessage ? <p className="priority-review__message">{errorMessage}</p> : null}

        <div className="priority-review__grid patient-board__pending-review-grid">
          <label>
            <span>First name</span>
            <input
              type="text"
              value={draft.firstName}
              onChange={(event) => onDraftChange({ ...draft, firstName: event.target.value })}
            />
          </label>
          <label>
            <span>Last name</span>
            <input
              type="text"
              value={draft.lastName}
              onChange={(event) => onDraftChange({ ...draft, lastName: event.target.value })}
            />
          </label>
          <label>
            <span>Description</span>
            <input
              type="text"
              value={draft.description}
              onChange={(event) => onDraftChange({ ...draft, description: event.target.value })}
            />
          </label>
          <label>
            <span>Time preference (optional)</span>
            <input
              type="text"
              value={draft.timePreferences}
              onChange={(event) => onDraftChange({ ...draft, timePreferences: event.target.value })}
            />
          </label>
          <label>
            <span>Admission timestamp</span>
            <input
              type="datetime-local"
              value={draft.admittedAtLocal}
              onChange={(event) => onDraftChange({ ...draft, admittedAtLocal: event.target.value })}
            />
          </label>
          <label>
            <span>Suggested priority</span>
            <input type="number" value={draft.prioritySuggested} readOnly />
          </label>
          <label>
            <span>Final priority (1-5)</span>
            <input
              type="number"
              min={1}
              max={5}
              step={1}
              value={draft.priorityFinal}
              onChange={(event) => onDraftChange({ ...draft, priorityFinal: Number(event.target.value) })}
            />
          </label>
          <label>
            <span>Override reason</span>
            <input
              type="text"
              value={draft.overrideReason}
              onChange={(event) => onDraftChange({ ...draft, overrideReason: event.target.value })}
              placeholder="Required if priority changes"
            />
          </label>
        </div>

        <div className="priority-review__reason">
          <span>AI reason</span>
          <p>{draft.modelReason}</p>
          <span>Confidence: {draft.priorityConfidence.toFixed(2)}</span>
        </div>

        <fieldset className="patient-board__pending-review-tasks">
          <legend>Task selection</legend>
          {taskDefinitions.map((task) => (
            <label key={task.id}>
              <input
                type="checkbox"
                checked={draft.selectedTaskDefinitionIds.includes(task.id)}
                onChange={() => onToggleTask(task.id)}
              />
              <span>{task.name}</span>
            </label>
          ))}
        </fieldset>

        <footer className="priority-review__actions">
          {draft.pdfUrl ? (
            <a className="card-btn" href={draft.pdfUrl} target="_blank" rel="noreferrer">
              Open transcript PDF
            </a>
          ) : null}
          <button type="button" className="card-btn" onClick={onClose} disabled={isSaving}>
            Cancel
          </button>
          <button type="button" className="card-btn card-btn--primary" onClick={onConfirm} disabled={isSaving}>
            {isSaving ? 'Confirming...' : 'Confirm and create patient'}
          </button>
        </footer>
      </section>
    </>
  )
}
