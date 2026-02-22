import { useEffect, useState } from 'react'
import LoadingOverlay from '../../components/loading-overlay/LoadingOverlay'
import {
  createPatientTask,
  listPatientTasksByStatus,
  toIsoFromDatetimeLocal,
  updatePatient,
  updatePatientTaskStatus,
} from './patientBoardApi'
import type { PatientCardData, PatientTaskData, TaskDefinitionData, TaskStatus } from './types'

interface PatientDetailsPopupProps {
  open: boolean
  patient: PatientCardData | null
  taskDefinitions: TaskDefinitionData[]
  onSaved: (warningMessage?: string) => Promise<void> | void
  onDelete: (patientExternalId: number) => Promise<void> | void
  onClose: () => void
}

type TaskSnapshotStatus = TaskStatus | 'unassigned'

interface TaskSnapshot {
  status: TaskSnapshotStatus
  patientTaskId: string | null
}

function toTaskStatusLabel(status: TaskSnapshotStatus): string {
  switch (status) {
    case 'pending':
      return 'pending'
    case 'done':
      return 'completed'
    case 'cancelled':
      return ''
    default:
      return ''
  }
}

export function PatientDetailsPopup({
  open,
  patient,
  taskDefinitions,
  onSaved,
  onDelete,
  onClose,
}: PatientDetailsPopupProps) {
  if (!open || !patient) {
    return null
  }

  return (
    <PatientDetailsPopupContent
      patient={patient}
      taskDefinitions={taskDefinitions}
      onSaved={onSaved}
      onDelete={onDelete}
      onClose={onClose}
    />
  )
}

function PatientDetailsPopupContent({
  patient,
  taskDefinitions,
  onSaved,
  onDelete,
  onClose,
}: Omit<PatientDetailsPopupProps, 'open' | 'patient'> & {
  patient: PatientCardData
}) {
  const [firstNameDraft, setFirstNameDraft] = useState(patient.firstName)
  const [lastNameDraft, setLastNameDraft] = useState(patient.lastName)
  const [descriptionDraft, setDescriptionDraft] = useState(patient.description)
  const [timePreferencesDraft, setTimePreferencesDraft] = useState(patient.timePreferences)
  const [admissionTimestampDraft, setAdmissionTimestampDraft] = useState(patient.admissionTimestamp)
  const [taskDraft, setTaskDraft] = useState<Record<string, boolean>>({})
  const [taskSnapshot, setTaskSnapshot] = useState<Record<string, TaskSnapshot>>({})
  const [isLoadingTasks, setIsLoadingTasks] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSaving && !isDeleting) {
        if (isDeleteConfirmOpen) {
          setIsDeleteConfirmOpen(false)
          return
        }
        onClose()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [isDeleteConfirmOpen, isDeleting, isSaving, onClose])

  useEffect(() => {
    setFirstNameDraft(patient.firstName)
    setLastNameDraft(patient.lastName)
    setDescriptionDraft(patient.description)
    setTimePreferencesDraft(patient.timePreferences)
    setAdmissionTimestampDraft(patient.admissionTimestamp)
    setIsDeleteConfirmOpen(false)
  }, [patient])

  useEffect(() => {
    let isCancelled = false

    const loadTasks = async () => {
      setIsLoadingTasks(true)
      setErrorMessage(null)

      try {
        const [pendingTasks, doneTasks, cancelledTasks] = await Promise.all([
          listPatientTasksByStatus(patient.externalPatientId, 'pending'),
          listPatientTasksByStatus(patient.externalPatientId, 'done'),
          listPatientTasksByStatus(patient.externalPatientId, 'cancelled'),
        ])

        if (isCancelled) return

        const snapshotByDefinition: Record<string, TaskSnapshot> = {}
        taskDefinitions.forEach((taskDefinition) => {
          snapshotByDefinition[taskDefinition.id] = { status: 'unassigned', patientTaskId: null }
        })

        const assignTaskList = (tasks: PatientTaskData[]) => {
          tasks.forEach((task) => {
            snapshotByDefinition[task.taskDefinitionId] = {
              status: task.status,
              patientTaskId: task.id,
            }
          })
        }

        assignTaskList(cancelledTasks)
        assignTaskList(pendingTasks)
        assignTaskList(doneTasks)

        const nextDraft: Record<string, boolean> = {}
        Object.entries(snapshotByDefinition).forEach(([taskDefinitionId, snapshot]) => {
          nextDraft[taskDefinitionId] = snapshot.status === 'pending' || snapshot.status === 'done'
        })

        setTaskSnapshot(snapshotByDefinition)
        setTaskDraft(nextDraft)
      } catch (error) {
        if (!isCancelled) {
          const message = error instanceof Error ? error.message : 'Failed to load patient tasks.'
          setErrorMessage(message)
        }
      } finally {
        if (!isCancelled) {
          setIsLoadingTasks(false)
        }
      }
    }

    void loadTasks()

    return () => {
      isCancelled = true
    }
  }, [patient.externalPatientId, taskDefinitions])

  const admittedAtIso = toIsoFromDatetimeLocal(admissionTimestampDraft)
  const isSaveDisabled =
    isSaving ||
    isLoadingTasks ||
    firstNameDraft.trim().length === 0 ||
    lastNameDraft.trim().length === 0 ||
    descriptionDraft.trim().length === 0 ||
    !admittedAtIso

  const toggleTask = (taskDefinitionId: string) => {
    const snapshot = taskSnapshot[taskDefinitionId]
    if (snapshot?.status === 'done') return

    setTaskDraft((current) => ({
      ...current,
      [taskDefinitionId]: !current[taskDefinitionId],
    }))
  }

  const syncTasks = async (): Promise<string[]> => {
    const failedTaskNames: string[] = []

    for (const taskDefinition of taskDefinitions) {
      const snapshot = taskSnapshot[taskDefinition.id] ?? { status: 'unassigned', patientTaskId: null }
      const isChecked = Boolean(taskDraft[taskDefinition.id])

      try {
        if (snapshot.status === 'done') {
          continue
        }

        if (isChecked) {
          if (snapshot.status === 'pending') {
            continue
          }
          if (snapshot.status === 'cancelled' && snapshot.patientTaskId) {
            await updatePatientTaskStatus(snapshot.patientTaskId, { status: 'pending' })
            continue
          }
          if (snapshot.status === 'unassigned') {
            await createPatientTask(patient.externalPatientId, {
              task_definition_id: taskDefinition.id,
              status: 'pending',
            })
          }
          continue
        }

        if (snapshot.status === 'pending' && snapshot.patientTaskId) {
          await updatePatientTaskStatus(snapshot.patientTaskId, { status: 'cancelled' })
        }
      } catch {
        failedTaskNames.push(taskDefinition.name)
      }
    }

    return failedTaskNames
  }

  const saveChanges = async () => {
    if (!admittedAtIso) return

    const nextFirstName = firstNameDraft.trim()
    const nextLastName = lastNameDraft.trim()
    const nextDescription = descriptionDraft.trim()
    const nextTimePreferences = timePreferencesDraft.trim()
    if (!nextFirstName || !nextLastName || !nextDescription) return

    setIsSaving(true)
    setErrorMessage(null)
    try {
      await updatePatient(patient.externalPatientId, {
        first_name: nextFirstName,
        last_name: nextLastName,
        description: nextDescription,
        time_preferences: nextTimePreferences || null,
        admitted_at: admittedAtIso,
      })

      const failedTaskNames = await syncTasks()
      const warningMessage =
        failedTaskNames.length > 0 ? `Patient updated, but some task updates failed: ${failedTaskNames.join(', ')}` : undefined

      await onSaved(warningMessage)
      onClose()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save patient details.'
      setErrorMessage(message)
    } finally {
      setIsSaving(false)
    }
  }

  const removePatient = async () => {
    if (isSaving || isDeleting) return
    setIsDeleteConfirmOpen(true)
  }

  const confirmDeletePatient = async () => {
    if (isSaving || isDeleting) return
    setIsDeleting(true)
    setErrorMessage(null)
    try {
      await onDelete(patient.externalPatientId)
      setIsDeleteConfirmOpen(false)
      onClose()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete patient.'
      setErrorMessage(message)
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="patient-popup__overlay"
        aria-label="Close patient details"
        onClick={() => {
          if (!isSaving && !isDeleting && !isDeleteConfirmOpen) onClose()
        }}
      />
      <section className="patient-popup" role="dialog" aria-modal="true" aria-label="Patient details">
        <header className="patient-popup__header">
          <h2>Patient details</h2>
          <button
            type="button"
            className="patient-popup__close"
            aria-label="Close popup"
            onClick={onClose}
            disabled={isSaving || isDeleting}
          >
            <span aria-hidden>×</span>
          </button>
        </header>
        {errorMessage ? <p className="patient-popup__message">{errorMessage}</p> : null}

        <div className="patient-popup__fields">
          <label>
            <span>Patient ID</span>
            <input type="number" min={0} value={patient.patientId} readOnly />
          </label>
          <label>
            <span>First name</span>
            <input type="text" value={firstNameDraft} onChange={(event) => setFirstNameDraft(event.target.value)} />
          </label>
          <label>
            <span>Last name</span>
            <input type="text" value={lastNameDraft} onChange={(event) => setLastNameDraft(event.target.value)} />
          </label>
          <label>
            <span>Admission timestamp</span>
            <input
              type="datetime-local"
              value={admissionTimestampDraft}
              onChange={(event) => setAdmissionTimestampDraft(event.target.value)}
            />
          </label>
          <label className="patient-popup__field--full">
            <span>Description</span>
            <input type="text" value={descriptionDraft} onChange={(event) => setDescriptionDraft(event.target.value)} />
          </label>
          <label className="patient-popup__field--full">
            <span>Time preferences</span>
            <input
              type="text"
              value={timePreferencesDraft}
              onChange={(event) => setTimePreferencesDraft(event.target.value)}
              placeholder="e.g. prefers mornings, avoid late afternoons"
            />
          </label>
          <div className="patient-popup__field--full patient-popup__transcript">
            <span>Voice transcript PDF</span>
            {patient.conversationPdfUrl ? (
              <a href={patient.conversationPdfUrl} target="_blank" rel="noreferrer">
                Open transcript
              </a>
            ) : (
              <p>No transcript attached.</p>
            )}
          </div>
        </div>

        <fieldset className="patient-popup__tasks">
          <legend>Assigned tasks</legend>
          {taskDefinitions.map((taskDefinition) => {
            const snapshot = taskSnapshot[taskDefinition.id] ?? { status: 'unassigned', patientTaskId: null }
            const isDone = snapshot?.status === 'done'
            const statusLabel = toTaskStatusLabel(snapshot.status)
            const statusTone = snapshot.status === 'done' ? 'completed' : snapshot.status

            return (
              <label key={taskDefinition.id} className={`patient-popup__task ${isDone ? 'patient-popup__task--done' : ''}`}>
                <input
                  type="checkbox"
                  checked={Boolean(taskDraft[taskDefinition.id])}
                  disabled={isDone || isLoadingTasks || isSaving || isDeleting}
                  onChange={() => toggleTask(taskDefinition.id)}
                />
                <span className="patient-popup__task-name">{taskDefinition.name}</span>
                {statusLabel ? (
                  <span className={`patient-popup__task-status patient-popup__task-status--${statusTone}`}>{statusLabel}</span>
                ) : null}
              </label>
            )
          })}
          {taskDefinitions.length === 0 ? <span className="patient-popup__tasks-empty">No task definitions available.</span> : null}
          {isLoadingTasks ? <span className="patient-popup__tasks-empty">Loading task statuses...</span> : null}
        </fieldset>

        <footer className="patient-popup__actions">
          <button type="button" className="card-btn card-btn--danger" disabled={isSaving || isDeleting} onClick={removePatient}>
            Remove
          </button>
          <div className="patient-popup__actions-right">
            <button type="button" className="card-btn" disabled={isSaving || isDeleting} onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="card-btn card-btn--primary"
              disabled={isSaveDisabled || isDeleting}
              onClick={saveChanges}
            >
              Save
            </button>
          </div>
        </footer>
      </section>
      {isDeleteConfirmOpen ? (
        <>
          <button
            type="button"
            className="priority-review__overlay"
            aria-label="Close delete confirmation"
            onClick={() => {
              if (!isDeleting) setIsDeleteConfirmOpen(false)
            }}
          />
          <section className="priority-review" role="dialog" aria-modal="true" aria-label="Delete patient confirmation">
            <header className="priority-review__header">
              <h2>Delete patient</h2>
              <button
                type="button"
                className="priority-review__close"
                onClick={() => setIsDeleteConfirmOpen(false)}
                disabled={isDeleting}
              >
                <span aria-hidden>×</span>
              </button>
            </header>
            <p className="priority-review__hint">This action cannot be undone. Are you sure you want to delete this patient?</p>
            <footer className="priority-review__actions">
              <button type="button" className="card-btn" onClick={() => setIsDeleteConfirmOpen(false)} disabled={isDeleting}>
                Cancel
              </button>
              <button type="button" className="card-btn card-btn--danger" onClick={confirmDeletePatient} disabled={isDeleting}>
                Delete
              </button>
            </footer>
          </section>
        </>
      ) : null}
      <LoadingOverlay
        open={isSaving || isDeleting}
        message={isDeleting ? 'Deleting patient...' : 'Saving patient...'}
        ariaLabel={isDeleting ? 'Deleting patient' : 'Saving patient'}
      />
    </>
  )
}
