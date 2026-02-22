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
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSaving) {
        onClose()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [isSaving, onClose])

  useEffect(() => {
    setFirstNameDraft(patient.firstName)
    setLastNameDraft(patient.lastName)
    setDescriptionDraft(patient.description)
    setTimePreferencesDraft(patient.timePreferences)
    setAdmissionTimestampDraft(patient.admissionTimestamp)
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
    const confirmed = window.confirm('Delete this patient? This action cannot be undone.')
    if (!confirmed) return

    setErrorMessage(null)
    try {
      await onDelete(patient.externalPatientId)
      onClose()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete patient.'
      setErrorMessage(message)
    }
  }

  return (
    <>
      <button
        type="button"
        className="patient-popup__overlay"
        aria-label="Close patient details"
        onClick={() => {
          if (!isSaving) onClose()
        }}
      />
      <section className="patient-popup" role="dialog" aria-modal="true" aria-label="Patient details">
        <header className="patient-popup__header">
          <h2>Patient details</h2>
          <button type="button" className="patient-popup__close" aria-label="Close popup" onClick={onClose} disabled={isSaving}>
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
        </div>

        <fieldset className="patient-popup__tasks">
          <legend>Assigned tasks</legend>
          {taskDefinitions.map((taskDefinition) => {
            const snapshot = taskSnapshot[taskDefinition.id]
            const isDone = snapshot?.status === 'done'

            return (
              <label key={taskDefinition.id} className={`patient-popup__task ${isDone ? 'patient-popup__task--done' : ''}`}>
                <input
                  type="checkbox"
                  checked={Boolean(taskDraft[taskDefinition.id])}
                  disabled={isDone || isLoadingTasks || isSaving}
                  onChange={() => toggleTask(taskDefinition.id)}
                />
                <span>{taskDefinition.name}</span>
              </label>
            )
          })}
          {taskDefinitions.length === 0 ? <span className="patient-popup__tasks-empty">No task definitions available.</span> : null}
          {isLoadingTasks ? <span className="patient-popup__tasks-empty">Loading task statuses...</span> : null}
        </fieldset>

        <footer className="patient-popup__actions">
          <button type="button" className="card-btn card-btn--danger" disabled={isSaving} onClick={removePatient}>
            Remove
          </button>
          <div className="patient-popup__actions-right">
            <button type="button" className="card-btn" disabled={isSaving} onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="card-btn card-btn--primary" disabled={isSaveDisabled} onClick={saveChanges}>
              Save
            </button>
          </div>
        </footer>
      </section>
      <LoadingOverlay open={isSaving} message="Saving patient..." ariaLabel="Saving patient" />
    </>
  )
}
