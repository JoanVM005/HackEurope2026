export interface Clinician {
  id: string
  name: string
  role: string
}

export const DEFAULT_CLINICIANS: Clinician[] = [
  { id: 'clin-1', name: 'Dr. Shah', role: 'OT' },
  { id: 'clin-2', name: 'Nurse Doyle', role: 'Nurse' },
  { id: 'clin-3', name: 'Dr. Almeida', role: 'Physio' },
  { id: 'clin-4', name: 'Dr. Kane', role: 'Doctor' },
  { id: 'clin-5', name: 'Dr. Jones', role: 'Dietician' },
  { id: 'clin-6', name: 'Dr. Smith', role: 'Research' },
  { id: 'clin-7', name: 'Mary Jane', role: 'SLT' },
]
