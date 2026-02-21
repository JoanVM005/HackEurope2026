export type TaskStatus = 'pending' | 'done' | 'cancelled'

export interface PatientCardData {
  id: string
  externalPatientId: string
  patientId: number
  firstName: string
  lastName: string
  description: string
  admissionTimestamp: string
}

export interface TaskDefinitionData {
  id: string
  name: string
}

export interface PatientTaskData {
  id: string
  taskDefinitionId: string
  taskName: string
  status: TaskStatus
  dueAt: string | null
}
