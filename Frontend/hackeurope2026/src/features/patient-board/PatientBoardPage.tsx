import { useState } from 'react'
import { mockPatients } from './mockPatients'
import { PatientCard } from './PatientCard'
import { TEST_TYPES } from './types'
import type { PatientCardData, TestChecklist, TestType } from './types'
import './patientBoard.css'

const emptyChecklist = (): TestChecklist => ({
  Bloods: false,
  CAT: false,
  MRI: false,
  Physio: false,
})

export default function PatientBoardPage() {
  const [patients, setPatients] = useState<PatientCardData[]>(mockPatients)
  const [newPatientName, setNewPatientName] = useState('')
  const [newPatientTests, setNewPatientTests] = useState<TestChecklist>(emptyChecklist)

  const addPatient = () => {
    const trimmedName = newPatientName.trim()
    if (!trimmedName) return

    const nextPatient: PatientCardData = {
      id: `pat-${crypto.randomUUID()}`,
      name: trimmedName,
      tests: newPatientTests,
    }

    setPatients((current) => [nextPatient, ...current])
    setNewPatientName('')
    setNewPatientTests(emptyChecklist())
  }

  const renamePatient = (patientId: string, nextName: string) => {
    setPatients((current) =>
      current.map((patient) => {
        if (patient.id !== patientId) return patient
        return {
          ...patient,
          name: nextName,
        }
      }),
    )
  }

  const togglePatientTest = (patientId: string, test: TestType) => {
    setPatients((current) =>
      current.map((patient) => {
        if (patient.id !== patientId) return patient
        return {
          ...patient,
          tests: {
            ...patient.tests,
            [test]: !patient.tests[test],
          },
        }
      }),
    )
  }

  const toggleNewPatientTest = (test: TestType) => {
    setNewPatientTests((current) => ({
      ...current,
      [test]: !current[test],
    }))
  }

  const deletePatient = (patientId: string) => {
    setPatients((current) => current.filter((patient) => patient.id !== patientId))
  }

  return (
    <main className="patient-board">
      <header className="patient-board__hero">
        <h1>Today's Patient Queue</h1>
        <p className="patient-board__subtitle">
          Add patients, tick required tests, and let the AI handle scheduling and order-of-execution in the background.
        </p>

        <form
          className="patient-board__composer"
          onSubmit={(event) => {
            event.preventDefault()
            addPatient()
          }}
        >
          <label className="patient-board__input-wrap">
            <span>Patient name</span>
            <input
              type="text"
              value={newPatientName}
              onChange={(event) => setNewPatientName(event.target.value)}
              placeholder="e.g. Nina Arendt"
            />
          </label>

          <fieldset className="patient-board__test-options">
            <legend>Required tests</legend>
            {TEST_TYPES.map((testType) => (
              <label key={testType}>
                <input
                  type="checkbox"
                  checked={newPatientTests[testType]}
                  onChange={() => toggleNewPatientTest(testType)}
                />
                <span>{testType}</span>
              </label>
            ))}
          </fieldset>

          <button type="submit" className="patient-board__add-btn">
            Add patient
          </button>
        </form>
      </header>

      <section className="patient-board__grid" aria-label="Patient cards">
        {patients.length > 0 ? (
          patients.map((patient) => (
            <PatientCard
              key={patient.id}
              patient={patient}
              testTypes={TEST_TYPES}
              onRename={renamePatient}
              onToggleTest={togglePatientTest}
              onDelete={deletePatient}
            />
          ))
        ) : (
          <p className="patient-board__empty">No patients yet. Add one above to start today’s list.</p>
        )}
      </section>
    </main>
  )
}
