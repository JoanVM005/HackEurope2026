import { useCallback, useEffect, useMemo, useState } from 'react'
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
import type { Clinician } from '../../types/clinician'
import type { PatientCardData, PriorityPreviewData, TaskDefinitionData } from './types'
import './patientBoard.css'

interface PatientBoardPageProps {
  onCreateSchedule?: () => void
  clinicians?: Clinician[]
  onCliniciansChange?: (clinicians: Clinician[]) => void
}

export default function PatientBoardPage({ onCreateSchedule }: PatientBoardPageProps) {
  const [patients, setPatients] = useState<PatientCardData[]>([])
  const [taskDefinitions, setTaskDefinitions] = useState<TaskDefinitionData[]>([])
  const [newPatientNumericId, setNewPatientNumericId] = useState('')
  const [newPatientFirstName, setNewPatientFirstName] = useState('')
  const [newPatientLastName, setNewPatientLastName] = useState('')
  const [newPatientDescription, setNewPatientDescription] = useState('')
  const [newPatientTimePreferences, setNewPatientTimePreferences] = useState('')
  const [newPatientAdmissionTimestamp, setNewPatientAdmissionTimestamp] = useState('')
  const [newPatientTaskSelection, setNewPatientTaskSelection] = useState<Record<string, boolean>>({})
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

  const selectedPatient = useMemo(
    () => patients.find((patient) => patient.id === selectedPatientId) ?? null,
    [patients, selectedPatientId],
  )

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setErrorMessage(null)
    try {
      const [loadedPatients, loadedTaskDefinitions] = await Promise.all([listPatients(), listTaskDefinitions()])
      setPatients(loadedPatients)
      setTaskDefinitions(loadedTaskDefinitions)
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

      if (failedTaskNames.length > 0) {
        setNoticeMessage(`Patient created, but some tasks failed: ${failedTaskNames.join(', ')}`)
      } else {
        setNoticeMessage('Patient created successfully.')
      }

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

  const handleDeletePatient = async (patientExternalId: string) => {
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

  return (
    <main className="patient-board">
      <header className="patient-board__hero">
        <h1>Today's Patient Queue</h1>
        <p className="patient-board__subtitle">
          Add patients, capture admission context and timestamp, then open each patient card for detailed edits.
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
      </header>

      <section className="patient-board__grid" aria-label="Patient cards">
        {isLoading ? (
          <p className="patient-board__empty">Loading patients...</p>
        ) : patients.length > 0 ? (
          patients.map((patient) => <PatientCard key={patient.id} patient={patient} onOpen={setSelectedPatientId} />)
        ) : (
          <p className="patient-board__empty">No patients yet. Add one above to start today’s list.</p>
        )}
      </section>

      <PatientDetailsPopup
        open={selectedPatient !== null}
        patient={selectedPatient}
        taskDefinitions={taskDefinitions}
        onSaved={handleSavedFromPopup}
        onDelete={handleDeletePatient}
        onClose={() => setSelectedPatientId(null)}
      />
      <LoadingOverlay
        open={isCreatingPatient}
        message="Creating patient and syncing tasks..."
        ariaLabel="Creating patient"
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

  const isOverride = finalPriority !== preview.suggestedPriority

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
