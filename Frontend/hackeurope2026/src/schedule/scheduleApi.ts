import { apiRequest } from '../lib/apiClient'

interface SchedulePlanResponseDto {
  items: ScheduleItemDto[]
  applied_preferences?: AppliedPreferencesSummaryDto | null
  warnings?: string[]
}

interface ScheduleItemDto {
  schedule_item_id: string
  task_name: string
  patient_name: string
  day: string
  hour: number
  priority: number
  priority_score: number
  reason: string
}

interface TaskDefinitionDto {
  id: string
  name: string
  created_at: string
  updated_at: string
}

interface AppliedPreferencesSummaryDto {
  doctor_id: string
  source: 'mem0' | 'default'
  time_blocks_count: number
  overrides_applied_count: number
  scoring_weights: {
    w_priority: number
    w_wait: number
  }
  language: 'es' | 'en'
}

export interface ScheduleItem {
  scheduleItemId: string
  taskName: string
  patientName: string
  day: string
  hour: number
  priority: number
  priorityScore: number
  reason: string
}

export interface ScheduleTaskDefinition {
  id: string
  name: string
}

export interface AppliedPreferencesSummary {
  doctorId: string
  source: 'mem0' | 'default'
  timeBlocksCount: number
  overridesAppliedCount: number
  scoringWeights: {
    wPriority: number
    wWait: number
  }
  language: 'es' | 'en'
}

export interface ReplanScheduleResult {
  items: ScheduleItem[]
  appliedPreferences?: AppliedPreferencesSummary | null
  warnings: string[]
}

function mapItem(dto: ScheduleItemDto): ScheduleItem {
  return {
    scheduleItemId: dto.schedule_item_id,
    taskName: dto.task_name,
    patientName: dto.patient_name,
    day: dto.day,
    hour: dto.hour,
    priority: dto.priority,
    priorityScore: dto.priority_score,
    reason: dto.reason,
  }
}

function mapAppliedPreferences(
  dto: AppliedPreferencesSummaryDto | null | undefined,
): AppliedPreferencesSummary | null {
  if (!dto) return null
  return {
    doctorId: dto.doctor_id,
    source: dto.source,
    timeBlocksCount: dto.time_blocks_count,
    overridesAppliedCount: dto.overrides_applied_count,
    scoringWeights: {
      wPriority: dto.scoring_weights.w_priority,
      wWait: dto.scoring_weights.w_wait,
    },
    language: dto.language,
  }
}

function mapTaskDefinition(dto: TaskDefinitionDto): ScheduleTaskDefinition {
  return {
    id: dto.id,
    name: dto.name,
  }
}

function mapPlan(response: SchedulePlanResponseDto): ScheduleItem[] {
  return response.items.map(mapItem)
}

export async function replanSchedule(): Promise<ReplanScheduleResult> {
  const response = await apiRequest<SchedulePlanResponseDto>('/schedule', { method: 'POST' })
  return {
    items: mapPlan(response),
    appliedPreferences: mapAppliedPreferences(response.applied_preferences),
    warnings: response.warnings ?? [],
  }
}

export async function listScheduleByDay(day: string): Promise<ScheduleItem[]> {
  const response = await apiRequest<SchedulePlanResponseDto>(`/schedule/day/${encodeURIComponent(day)}`)
  return mapPlan(response)
}

export async function listScheduleByPatient(patientId: string): Promise<ScheduleItem[]> {
  const response = await apiRequest<SchedulePlanResponseDto>(`/schedule/${encodeURIComponent(patientId)}`)
  return mapPlan(response)
}

export async function deleteScheduleItem(scheduleItemId: string): Promise<void> {
  await apiRequest<void>(`/schedule/${encodeURIComponent(scheduleItemId)}`, {
    method: 'DELETE',
  })
}

export async function listTaskDefinitions(): Promise<ScheduleTaskDefinition[]> {
  const response = await apiRequest<TaskDefinitionDto[]>('/task-definitions')
  return response.map(mapTaskDefinition)
}
