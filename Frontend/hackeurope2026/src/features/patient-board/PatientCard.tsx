import { useState } from 'react'
import type { PatientCardData, TestType } from './types'

interface PatientCardProps {
  patient: PatientCardData
  testTypes: readonly TestType[]
  onRename: (patientId: string, nextName: string) => void
  onToggleTest: (patientId: string, test: TestType) => void
  onDelete: (patientId: string) => void
}

export function PatientCard({ patient, testTypes, onRename, onToggleTest, onDelete }: PatientCardProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [nameDraft, setNameDraft] = useState(patient.name)
  const selectedTestCount = testTypes.filter((testType) => patient.tests[testType]).length

  const saveName = () => {
    const trimmed = nameDraft.trim()
    if (!trimmed) {
      setNameDraft(patient.name)
      setIsEditing(false)
      return
    }

    onRename(patient.id, trimmed)
    setIsEditing(false)
  }

  return (
    <article className="patient-card">
      <header className="patient-card__header">
        {isEditing ? (
          <input
            className="patient-card__name-input"
            type="text"
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
            aria-label={`Rename ${patient.name}`}
          />
        ) : (
          <h2>{patient.name}</h2>
        )}

        <div className="patient-card__actions">
          {isEditing ? (
            <button type="button" className="card-btn card-btn--primary" onClick={saveName}>
              Save
            </button>
          ) : (
            <button
              type="button"
              className="card-btn"
              onClick={() => {
                setNameDraft(patient.name)
                setIsEditing(true)
              }}
            >
              Rename
            </button>
          )}

          <button type="button" className="card-btn card-btn--danger" onClick={() => onDelete(patient.id)}>
            Remove
          </button>
        </div>
      </header>

      <p className="patient-card__meta">{selectedTestCount} tests selected for AI scheduling</p>

      <ul className="test-checklist">
        {testTypes.map((testType) => (
          <li key={testType} className="test-checklist__item">
            <label>
              <input
                type="checkbox"
                checked={patient.tests[testType]}
                onChange={() => onToggleTest(patient.id, testType)}
              />
              <span>{testType}</span>
            </label>
          </li>
        ))}
      </ul>
    </article>
  )
}
