import type { PatientCardData, PatientTaskData, PriorityPreviewData, TaskDefinitionData, TaskStatus } from './types'
import { apiRequest } from '../../lib/apiClient'

interface PatientResponseDto {
  id: string
  patient_id: number
  first_name: string
  last_name: string
  description: string
  time_preferences?: string | null
  priority_final: number
  priority_suggested?: number | null
  model_reason?: string | null
  confidence?: number | null
  override_reason?: string | null
  admitted_at: string | null
  created_at: string
  updated_at: string
}

interface TaskDefinitionResponseDto {
  id: string
  name: string
  created_at: string
  updated_at: string
}

interface PatientTaskResponseDto {
  id: string
  patient_id: string
  patient_external_id?: string | null
  task_definition_id: string
  task_name: string
  status: TaskStatus
  due_at: string | null
  created_at: string
  updated_at: string
}

interface CreatePatientPayload {
  patient_id: number
  first_name: string
  last_name: string
  description: string
  time_preferences?: string | null
  priority_final: number
  priority_suggested?: number | null
  model_reason?: string | null
  confidence?: number | null
  override_reason?: string | null
  admitted_at: string | null
}

interface UpdatePatientPayload {
  first_name?: string
  last_name?: string
  description?: string
  time_preferences?: string | null
  priority_final?: number
  priority_suggested?: number | null
  model_reason?: string | null
  confidence?: number | null
  override_reason?: string | null
  admitted_at?: string | null
}

interface PriorityPreviewRequestPayload {
  first_name?: string
  last_name?: string
  description: string
  time_preferences?: string | null
  admitted_at?: string | null
  task_names?: string[]
}

interface PriorityPreviewResponseDto {
  suggested_priority: number
  confidence: number
  model_reason: string
}

interface CreatePatientTaskPayload {
  task_definition_id: string
  status: 'pending'
}

interface UpdatePatientTaskPayload {
  status: Extract<TaskStatus, 'pending' | 'cancelled'>
}

function toDatetimeLocal(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 16)
}

function parseNumericPatientId(value: string | number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function mapPatientDtoToUi(dto: PatientResponseDto): PatientCardData {
  return {
    id: dto.id,
    externalPatientId: dto.patient_id,
    patientId: parseNumericPatientId(dto.patient_id),
    firstName: dto.first_name,
    lastName: dto.last_name,
    description: dto.description,
    timePreferences: dto.time_preferences ?? '',
    priorityFinal: dto.priority_final,
    prioritySuggested: dto.priority_suggested ?? null,
    modelReason: dto.model_reason ?? null,
    confidence: dto.confidence ?? null,
    overrideReason: dto.override_reason ?? null,
    admissionTimestamp: toDatetimeLocal(dto.admitted_at),
  }
}

function mapTaskDefinitionDtoToUi(dto: TaskDefinitionResponseDto): TaskDefinitionData {
  return {
    id: dto.id,
    name: dto.name,
  }
}

function mapPatientTaskDtoToUi(dto: PatientTaskResponseDto): PatientTaskData {
  return {
    id: dto.id,
    taskDefinitionId: dto.task_definition_id,
    taskName: dto.task_name,
    status: dto.status,
    dueAt: dto.due_at,
  }
}

export function toIsoFromDatetimeLocal(value: string): string | null {
  if (!value.trim()) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

export async function listPatients(): Promise<PatientCardData[]> {
  const response = await apiRequest<PatientResponseDto[]>('/patients')
  return response.map(mapPatientDtoToUi)
}

export async function createPatient(payload: CreatePatientPayload): Promise<PatientCardData> {
  const response = await apiRequest<PatientResponseDto>('/patients', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return mapPatientDtoToUi(response)
}

export async function updatePatient(patientExternalId: number, payload: UpdatePatientPayload): Promise<PatientCardData> {
  const response = await apiRequest<PatientResponseDto>(`/patients/${encodeURIComponent(patientExternalId)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
  return mapPatientDtoToUi(response)
}

export async function previewPatientPriority(payload: PriorityPreviewRequestPayload): Promise<PriorityPreviewData> {
  const response = await apiRequest<PriorityPreviewResponseDto>('/patients/priority-preview', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

  return {
    suggestedPriority: response.suggested_priority,
    confidence: response.confidence,
    modelReason: response.model_reason,
  }
}

export async function deletePatient(patientExternalId: number): Promise<void> {
  await apiRequest<void>(`/patients/${encodeURIComponent(patientExternalId)}`, {
    method: 'DELETE',
  })
}

export async function listTaskDefinitions(): Promise<TaskDefinitionData[]> {
  const response = await apiRequest<TaskDefinitionResponseDto[]>('/task-definitions')
  return response.map(mapTaskDefinitionDtoToUi)
}

export async function listPatientTasksByStatus(
  patientExternalId: number,
  status: TaskStatus,
): Promise<PatientTaskData[]> {
  const response = await apiRequest<PatientTaskResponseDto[]>(
    `/patients/${encodeURIComponent(patientExternalId)}/tasks?status=${status}`,
  )
  return response.map(mapPatientTaskDtoToUi)
}

export async function createPatientTask(patientExternalId: number, payload: CreatePatientTaskPayload): Promise<PatientTaskData> {
  const response = await apiRequest<PatientTaskResponseDto>(`/patients/${encodeURIComponent(patientExternalId)}/tasks`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return mapPatientTaskDtoToUi(response)
}

export async function updatePatientTaskStatus(
  patientTaskId: string,
  payload: UpdatePatientTaskPayload,
): Promise<PatientTaskData> {
  const response = await apiRequest<PatientTaskResponseDto>(`/patient-tasks/${encodeURIComponent(patientTaskId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
  return mapPatientTaskDtoToUi(response)
}
