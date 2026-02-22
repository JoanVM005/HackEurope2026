import { useCallback, useEffect, useMemo, useState } from 'react'
import { PatientCard } from './PatientCard'
import { PatientDetailsPopup } from './PatientDetailsPopup'
import {
  createPatient,
  createPatientTask,
  deletePatient,
  listPatients,
  listTaskDefinitions,
  toIsoFromDatetimeLocal,
} from './patientBoardApi'
import type { Clinician } from '../../types/clinician'
import type { PatientCardData, TaskDefinitionData } from './types'
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
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null)

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

  const addPatient = async () => {
    if (isCreatingPatient) return

    const parsedPatientId = Number.parseInt(newPatientNumericId, 10)
    const trimmedFirstName = newPatientFirstName.trim()
    const trimmedLastName = newPatientLastName.trim()
    const trimmedDescription = newPatientDescription.trim()
    const trimmedTimePreferences = newPatientTimePreferences.trim()
    const admittedAt = toIsoFromDatetimeLocal(newPatientAdmissionTimestamp)
    const hasIdConflict = patients.some((patient) => patient.patientId === parsedPatientId)

    if (!Number.isInteger(parsedPatientId) || parsedPatientId < 0) return
    if (!trimmedFirstName || !trimmedLastName || !trimmedDescription || !admittedAt) return
    if (hasIdConflict) return

    setErrorMessage(null)
    setNoticeMessage(null)
    setIsCreatingPatient(true)

    try {
      const createdPatient = await createPatient({
        patient_id: String(parsedPatientId),
        first_name: trimmedFirstName,
        last_name: trimmedLastName,
        description: trimmedDescription,
        time_preferences: trimmedTimePreferences || null,
        admitted_at: admittedAt,
      })

      const selectedTaskDefinitions = taskDefinitions.filter((taskDefinition) => newPatientTaskSelection[taskDefinition.id])
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
            addPatient()
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
            {isCreatingPatient ? 'Creating...' : 'Add patient'}
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

      {isCreatingPatient ? (
        <div className="patient-board__loading-overlay" role="status" aria-live="polite">
          <div className="patient-board__loading-modal">
            <span className="patient-board__loading-spinner" aria-hidden />
            <p>Creating patient and syncing tasks...</p>
          </div>
        </div>
      ) : null}
    </main>
  )
}
