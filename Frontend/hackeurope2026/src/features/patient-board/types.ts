export type TaskStatus = 'pending' | 'done' | 'cancelled'

export interface PatientCardData {
  id: string
  externalPatientId: number
  patientId: number
  firstName: string
  lastName: string
  description: string
  timePreferences: string
  conversationPdfUrl: string | null
  priorityFinal: number
  prioritySuggested: number | null
  modelReason: string | null
  confidence: number | null
  overrideReason: string | null
  admissionTimestamp: string
}

export interface PriorityPreviewData {
  suggestedPriority: number
  confidence: number
  modelReason: string
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
