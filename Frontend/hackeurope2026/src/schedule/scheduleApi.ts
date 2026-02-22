import { apiRequest, getDoctorId } from '../lib/apiClient'

const API_PREFIX = '/api'

interface SchedulePlanResponseDto {
  items: ScheduleItemDto[]
  applied_preferences?: AppliedPreferencesSummaryDto | null
  warnings?: string[]
}

interface ScheduleItemDto {
  schedule_item_id: string
  source_patient_task_id?: string | null
  task_name: string
  patient_name: string
  day: string
  hour: number
  priority: number
  priority_score: number
  reason: string
  status?: 'pending' | 'completed'
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
    w_time_pref: number
  }
  language: 'es' | 'en'
}

export interface ScheduleItem {
  scheduleItemId: string
  sourcePatientTaskId: string | null
  taskName: string
  patientName: string
  day: string
  hour: number
  priority: number
  priorityScore: number
  reason: string
  status: 'pending' | 'completed'
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
    wTimePref: number
  }
  language: 'es' | 'en'
}

export interface ReplanScheduleResult {
  items: ScheduleItem[]
  appliedPreferences?: AppliedPreferencesSummary | null
  warnings: string[]
}

interface CompleteScheduleItemsResponseDto {
  completed_ids: string[]
  skipped_ids: string[]
  warnings?: string[]
}

interface RescheduleOptionDto {
  scheduled_for: string
  day: string
  hour: number
}

interface RescheduleOptionsResponseDto {
  schedule_item_id: string
  options: RescheduleOptionDto[]
  warnings?: string[]
}

interface RescheduleResponseDto {
  schedule_item_id: string
  scheduled_for: string
  notice: string
}

interface RemoveFlowStartResponseDto {
  original_schedule_item_id: string
  working_schedule_item_id: string
  source_patient_task_id: string
  options: RescheduleOptionDto[]
  warnings?: string[]
}

interface RemoveFlowCancelResponseDto {
  schedule_item_id: string
  source_patient_task_id: string
  notice: string
}

interface RescheduleConflictDetailDto {
  message?: string
  options?: RescheduleOptionDto[]
  warnings?: string[]
}

interface ApiErrorDto {
  detail?: string | RescheduleConflictDetailDto
}

export interface CompleteScheduleItemsResult {
  completedIds: string[]
  skippedIds: string[]
  warnings: string[]
}

export interface ScheduleRescheduleOption {
  scheduledFor: string
  day: string
  hour: number
}

export interface ScheduleRescheduleOptionsResult {
  scheduleItemId: string
  options: ScheduleRescheduleOption[]
  warnings: string[]
}

export interface ScheduleRescheduleResult {
  scheduleItemId: string
  scheduledFor: string
  notice: string
}

export interface RemoveFlowStartResult {
  originalScheduleItemId: string
  workingScheduleItemId: string
  sourcePatientTaskId: string
  options: ScheduleRescheduleOption[]
  warnings: string[]
}

export interface RemoveFlowApplyResult {
  scheduleItemId: string
  scheduledFor: string
  notice: string
}

export interface RemoveFlowCancelResult {
  scheduleItemId: string
  sourcePatientTaskId: string
  notice: string
}

export class ScheduleRescheduleConflictError extends Error {
  readonly options: ScheduleRescheduleOption[]
  readonly warnings: string[]

  constructor(message: string, options: ScheduleRescheduleOption[], warnings: string[]) {
    super(message)
    this.name = 'ScheduleRescheduleConflictError'
    this.options = options
    this.warnings = warnings
  }
}

function mapItem(dto: ScheduleItemDto): ScheduleItem {
  return {
    scheduleItemId: dto.schedule_item_id,
    sourcePatientTaskId: dto.source_patient_task_id ?? null,
    taskName: dto.task_name,
    patientName: dto.patient_name,
    day: dto.day,
    hour: dto.hour,
    priority: dto.priority,
    priorityScore: dto.priority_score,
    reason: dto.reason,
    status: dto.status === 'completed' ? 'completed' : 'pending',
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
      wTimePref: dto.scoring_weights.w_time_pref,
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

function mapRescheduleOption(dto: RescheduleOptionDto): ScheduleRescheduleOption {
  return {
    scheduledFor: dto.scheduled_for,
    day: dto.day,
    hour: dto.hour,
  }
}

function buildScheduleHeaders(includeJsonContentType = false): Headers {
  const headers = new Headers()
  headers.set('X-Doctor-Id', getDoctorId())
  if (includeJsonContentType) {
    headers.set('Content-Type', 'application/json')
  }
  return headers
}

async function parseApiErrorMessage(response: Response): Promise<string> {
  let message = `HTTP ${response.status}`
  try {
    const body = (await response.json()) as ApiErrorDto
    if (typeof body.detail === 'string' && body.detail.trim()) {
      message = body.detail
    }
  } catch {
    message = response.statusText || message
  }
  return message
}

async function parseScheduleConflictError(
  response: Response,
  fallbackMessage: string,
): Promise<ScheduleRescheduleConflictError> {
  try {
    const body = (await response.json()) as ApiErrorDto
    const detail = typeof body.detail === 'object' && body.detail ? body.detail : null
    const conflictDetail = detail as RescheduleConflictDetailDto | null
    const options = (conflictDetail?.options ?? []).map(mapRescheduleOption)
    const warnings = conflictDetail?.warnings ?? []
    const message = conflictDetail?.message?.trim() || fallbackMessage
    return new ScheduleRescheduleConflictError(message, options, warnings)
  } catch {
    return new ScheduleRescheduleConflictError(fallbackMessage, [], [])
  }
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

export async function completeScheduleItems(scheduleItemIds: string[]): Promise<CompleteScheduleItemsResult> {
  const response = await apiRequest<CompleteScheduleItemsResponseDto>('/schedule/complete', {
    method: 'POST',
    body: JSON.stringify({
      schedule_item_ids: scheduleItemIds,
    }),
  })

  return {
    completedIds: response.completed_ids,
    skippedIds: response.skipped_ids,
    warnings: response.warnings ?? [],
  }
}

export async function getRescheduleOptions(scheduleItemId: string): Promise<ScheduleRescheduleOptionsResult> {
  const response = await apiRequest<RescheduleOptionsResponseDto>(
    `/schedule/${encodeURIComponent(scheduleItemId)}/reschedule-options`,
  )
  return {
    scheduleItemId: response.schedule_item_id,
    options: response.options.map(mapRescheduleOption),
    warnings: response.warnings ?? [],
  }
}

export async function rescheduleItem(
  scheduleItemId: string,
  scheduledForIso: string,
): Promise<ScheduleRescheduleResult> {
  const response = await fetch(`${API_PREFIX}/schedule/${encodeURIComponent(scheduleItemId)}/reschedule`, {
    method: 'POST',
    headers: buildScheduleHeaders(true),
    body: JSON.stringify({
      scheduled_for: scheduledForIso,
    }),
  })

  if (response.status === 409) {
    throw await parseScheduleConflictError(response, 'Selected slot is no longer available.')
  }

  if (!response.ok) {
    const message = await parseApiErrorMessage(response)
    throw new Error(message)
  }

  const payload = (await response.json()) as RescheduleResponseDto
  return {
    scheduleItemId: payload.schedule_item_id,
    scheduledFor: payload.scheduled_for,
    notice: payload.notice,
  }
}

export async function startRemoveFlow(scheduleItemId: string): Promise<RemoveFlowStartResult> {
  const response = await fetch(`${API_PREFIX}/schedule/${encodeURIComponent(scheduleItemId)}/remove-flow/start`, {
    method: 'POST',
    headers: buildScheduleHeaders(),
  })

  if (response.status === 409) {
    throw await parseScheduleConflictError(response, 'No block of 3 consecutive free slots is currently available.')
  }

  if (!response.ok) {
    const message = await parseApiErrorMessage(response)
    throw new Error(message)
  }

  const payload = (await response.json()) as RemoveFlowStartResponseDto
  return {
    originalScheduleItemId: payload.original_schedule_item_id,
    workingScheduleItemId: payload.working_schedule_item_id,
    sourcePatientTaskId: payload.source_patient_task_id,
    options: payload.options.map(mapRescheduleOption),
    warnings: payload.warnings ?? [],
  }
}

export async function applyRemoveFlow(
  workingScheduleItemId: string,
  scheduledForIso: string,
): Promise<RemoveFlowApplyResult> {
  const response = await fetch(`${API_PREFIX}/schedule/${encodeURIComponent(workingScheduleItemId)}/remove-flow/apply`, {
    method: 'POST',
    headers: buildScheduleHeaders(true),
    body: JSON.stringify({
      scheduled_for: scheduledForIso,
    }),
  })

  if (response.status === 409) {
    throw await parseScheduleConflictError(response, 'Selected slot is no longer available.')
  }

  if (!response.ok) {
    const message = await parseApiErrorMessage(response)
    throw new Error(message)
  }

  const payload = (await response.json()) as RescheduleResponseDto
  return {
    scheduleItemId: payload.schedule_item_id,
    scheduledFor: payload.scheduled_for,
    notice: payload.notice,
  }
}

export async function cancelTaskFromRemoveFlow(workingScheduleItemId: string): Promise<RemoveFlowCancelResult> {
  const response = await fetch(
    `${API_PREFIX}/schedule/${encodeURIComponent(workingScheduleItemId)}/remove-flow/cancel-task`,
    {
      method: 'POST',
      headers: buildScheduleHeaders(),
    },
  )

  if (!response.ok) {
    const message = await parseApiErrorMessage(response)
    throw new Error(message)
  }

  const payload = (await response.json()) as RemoveFlowCancelResponseDto
  return {
    scheduleItemId: payload.schedule_item_id,
    sourcePatientTaskId: payload.source_patient_task_id,
    notice: payload.notice,
  }
}
