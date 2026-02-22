import type { PatientCardData } from './types'

interface PatientCardProps {
  patient: PatientCardData
  onOpen: (patientId: string) => void
}

export function PatientCard({ patient, onOpen }: PatientCardProps) {
  const parsedDate = new Date(patient.admissionTimestamp)
  const formattedTimestamp = Number.isNaN(parsedDate.getTime())
    ? patient.admissionTimestamp
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(parsedDate)

  return (
    <button type="button" className="patient-card" onClick={() => onOpen(patient.id)}>
      <span className="patient-card__id">ID {patient.patientId}</span>
      <span className="patient-card__name">
        {patient.firstName} {patient.lastName}
      </span>
      <span className="patient-card__preference">
        {patient.timePreferences ? `Pref: ${patient.timePreferences}` : 'Pref: none set'}
      </span>
      <span className="patient-card__preference">
        Transcript: {patient.conversationPdfUrl ? 'available' : 'none'}
      </span>
      <span className="patient-card__timestamp">{formattedTimestamp}</span>
    </button>
  )
}
