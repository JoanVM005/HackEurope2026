const API_PREFIX = '/api'

interface ApiErrorBody {
  detail?: string
}

interface SchedulePlanResponseDto {
  items: ScheduleItemDto[]
}

interface ScheduleItemDto {
  schedule_item_id: string
  task_name: string
  patient_name: string
  day: string
  hour: number
  priority_score: number
  reason: string
}

export interface ScheduleItem {
  scheduleItemId: string
  taskName: string
  patientName: string
  day: string
  hour: number
  priorityScore: number
  reason: string
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  })

  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const body = (await response.json()) as ApiErrorBody
      if (body.detail) message = body.detail
    } catch {
      message = response.statusText || message
    }
    throw new Error(message)
  }

  if (response.status === 204) {
    return undefined as T
  }

  return (await response.json()) as T
}

function mapItem(dto: ScheduleItemDto): ScheduleItem {
  return {
    scheduleItemId: dto.schedule_item_id,
    taskName: dto.task_name,
    patientName: dto.patient_name,
    day: dto.day,
    hour: dto.hour,
    priorityScore: dto.priority_score,
    reason: dto.reason,
  }
}

function mapPlan(response: SchedulePlanResponseDto): ScheduleItem[] {
  return response.items.map(mapItem)
}

export async function listSchedule(): Promise<ScheduleItem[]> {
  const response = await apiRequest<SchedulePlanResponseDto>('/schedule')
  return mapPlan(response)
}

export async function replanSchedule(): Promise<ScheduleItem[]> {
  const response = await apiRequest<SchedulePlanResponseDto>('/schedule', { method: 'POST' })
  return mapPlan(response)
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
