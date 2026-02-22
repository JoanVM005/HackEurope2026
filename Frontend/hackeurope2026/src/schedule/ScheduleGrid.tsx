import './ScheduleGrid.css'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import LoadingOverlay from '../components/loading-overlay/LoadingOverlay'
import { getDoctorId } from '../lib/apiClient'
import {
  deleteScheduleItem,
  listScheduleByDay,
  listScheduleByPatient,
  listTaskDefinitions,
  replanSchedule,
  type ReplanScheduleResult,
  type ScheduleItem,
  type ScheduleTaskDefinition,
} from './scheduleApi'

type ScheduleGridProps = {
  onConfigurePatients?: () => void
}

type FilterMode = 'day' | 'patient'

const STEP_MINUTES = 60
const MIN_TIME = 0
const MAX_START_TIME = 22 * 60
const MAX_END_TIME = 23 * 60

function sortPlanItems(items: ScheduleItem[]): ScheduleItem[] {
  return [...items].sort((a, b) => {
    const dayCompare = a.day.localeCompare(b.day)
    if (dayCompare !== 0) return dayCompare
    if (a.hour !== b.hour) return a.hour - b.hour
    return a.taskName.localeCompare(b.taskName)
  })
}

function buildCellKey(hour: number, taskName: string): string {
  return `${hour}|${normalizeTaskKey(taskName)}`
}

export function ScheduleGrid({ onConfigurePatients }: ScheduleGridProps) {
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('17:00')
  const [filterMode, setFilterMode] = useState<FilterMode>('day')
  const [dayFilter, setDayFilter] = useState(() => new Date().toISOString().slice(0, 10))
  const [patientFilter, setPatientFilter] = useState('')
  const [items, setItems] = useState<ScheduleItem[]>([])
  const [taskDefinitions, setTaskDefinitions] = useState<ScheduleTaskDefinition[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingTasks, setIsLoadingTasks] = useState(true)
  const [isReplanning, setIsReplanning] = useState(false)
  const [isRemovingItem, setIsRemovingItem] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null)
  const [lastReplan, setLastReplan] = useState<ReplanScheduleResult | null>(null)

  const timeSlots = useMemo(() => createTimeSlots(startTime, endTime), [startTime, endTime])
  const slotHours = useMemo(() => {
    const hours = new Set<number>()
    for (const slot of timeSlots) {
      hours.add(Number(slot.slice(0, 2)))
    }
    return hours
  }, [timeSlots])

  const taskColumns = useMemo(
    () => [...taskDefinitions].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [taskDefinitions],
  )

  const columnWidthRem = 12
  const timeColumnWidthRem = 8.5
  const taskColumnCount = Math.max(taskColumns.length, 1)
  const minGridWidthRem = timeColumnWidthRem + taskColumnCount * columnWidthRem

  const previewItems = useMemo(() => {
    if (!lastReplan) return []
    return sortPlanItems(lastReplan.items).slice(0, 8)
  }, [lastReplan])

  const groupedItems = useMemo(() => {
    const groups = new Map<string, ScheduleItem[]>()

    for (const item of items) {
      const key = buildCellKey(item.hour, item.taskName)
      const current = groups.get(key)
      if (current) {
        current.push(item)
      } else {
        groups.set(key, [item])
      }
    }

    for (const bucket of groups.values()) {
      bucket.sort((a, b) => {
        const byDay = a.day.localeCompare(b.day)
        if (byDay !== 0) return byDay
        if (a.priorityScore !== b.priorityScore) return b.priorityScore - a.priorityScore
        return a.patientName.localeCompare(b.patientName, undefined, { sensitivity: 'base' })
      })
    }

    return groups
  }, [items])

  const hiddenByHoursCount = useMemo(
    () => items.reduce((count, item) => (slotHours.has(item.hour) ? count : count + 1), 0),
    [items, slotHours],
  )

  const loadTaskColumns = useCallback(async () => {
    setIsLoadingTasks(true)
    try {
      const definitions = await listTaskDefinitions()
      setTaskDefinitions(definitions)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load task definitions.'
      setErrorMessage(message)
      setTaskDefinitions([])
    } finally {
      setIsLoadingTasks(false)
    }
  }, [])

  const loadSchedule = useCallback(async () => {
    setIsLoading(true)
    setErrorMessage(null)

    try {
      const scheduleItems =
        filterMode === 'day' ? await listScheduleByDay(dayFilter) : await listScheduleByPatient(patientFilter.trim())
      setItems(scheduleItems)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load schedule.'
      setErrorMessage(message)
      setItems([])
    } finally {
      setIsLoading(false)
    }
  }, [dayFilter, filterMode, patientFilter])

  useEffect(() => {
    void loadTaskColumns()
  }, [loadTaskColumns])

  useEffect(() => {
    if (filterMode === 'patient' && !patientFilter.trim()) {
      setItems([])
      setIsLoading(false)
      return
    }

    void loadSchedule()
  }, [filterMode, patientFilter, loadSchedule])

  const handleReplan = async () => {
    if (isReplanning) return

    setIsReplanning(true)
    setErrorMessage(null)
    setNoticeMessage(null)

    try {
      const result = await replanSchedule()
      setLastReplan(result)
      setNoticeMessage('Schedule replanned successfully.')
      await loadSchedule()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to run planner.'
      setErrorMessage(message)
    } finally {
      setIsReplanning(false)
    }
  }

  const handleDelete = async (scheduleItemId: string) => {
    if (isRemovingItem) return

    setIsRemovingItem(true)
    setErrorMessage(null)
    setNoticeMessage(null)

    try {
      await deleteScheduleItem(scheduleItemId)
      await loadSchedule()
      setNoticeMessage('Schedule item removed and plan refreshed.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete schedule item.'
      setErrorMessage(message)
    } finally {
      setIsRemovingItem(false)
    }
  }

  return (
    <section className="schedule" aria-label="Task timetable">
      <header className="schedule-header">
        <div>
          <h1>Today's Timetable</h1>
          <p>
            Times are shown on the left and task definitions across the top. Scheduled items are grouped consistently by
            hour and matching task column.
          </p>
          <div className="time-controls" aria-label="Clinic hours">
            <label className="time-control">
              <span>Start time</span>
              <input
                type="time"
                step={STEP_MINUTES * 60}
                min="00:00"
                max="22:00"
                value={startTime}
                onChange={(event) => {
                  const newStart = clamp(minutesFromTime(event.target.value), MIN_TIME, MAX_START_TIME)
                  const currentEnd = minutesFromTime(endTime)
                  const correctedEnd =
                    newStart < currentEnd ? currentEnd : clamp(newStart + STEP_MINUTES, STEP_MINUTES, MAX_END_TIME)

                  setStartTime(timeFromMinutes(newStart))
                  setEndTime(timeFromMinutes(correctedEnd))
                }}
              />
            </label>
            <label className="time-control">
              <span>End time</span>
              <input
                type="time"
                step={STEP_MINUTES * 60}
                min="01:00"
                max="23:00"
                value={endTime}
                onChange={(event) => {
                  const newEnd = clamp(minutesFromTime(event.target.value), STEP_MINUTES, MAX_END_TIME)
                  const currentStart = minutesFromTime(startTime)
                  const correctedStart =
                    newEnd > currentStart ? currentStart : clamp(newEnd - STEP_MINUTES, MIN_TIME, MAX_START_TIME)

                  setEndTime(timeFromMinutes(newEnd))
                  setStartTime(timeFromMinutes(correctedStart))
                }}
              />
            </label>
          </div>
          <div className="schedule-filters" aria-label="Schedule filters">
            <label className="schedule-filter">
              <span>View</span>
              <select value={filterMode} onChange={(event) => setFilterMode(event.target.value as FilterMode)}>
                <option value="day">By day</option>
                <option value="patient">By patient</option>
              </select>
            </label>
            {filterMode === 'day' ? (
              <label className="schedule-filter">
                <span>Day</span>
                <input type="date" value={dayFilter} onChange={(event) => setDayFilter(event.target.value)} />
              </label>
            ) : null}
            {filterMode === 'patient' ? (
              <label className="schedule-filter">
                <span>Patient ID</span>
                <input
                  type="number"
                  min={1}
                  placeholder="e.g. 1001"
                  value={patientFilter}
                  onChange={(event) => setPatientFilter(event.target.value)}
                />
              </label>
            ) : null}
          </div>
          {errorMessage ? <p className="schedule-feedback schedule-feedback--error">{errorMessage}</p> : null}
          {noticeMessage ? <p className="schedule-feedback schedule-feedback--notice">{noticeMessage}</p> : null}
          {hiddenByHoursCount > 0 ? (
            <p className="schedule-feedback schedule-feedback--warn">
              {hiddenByHoursCount} appointment{hiddenByHoursCount > 1 ? 's are' : ' is'} outside the selected clinic hours.
            </p>
          ) : null}
        </div>
        <div className="schedule-actions">
          <span className="task-count">{taskDefinitions.length} tasks</span>
          {onConfigurePatients ? (
            <button type="button" className="page-action-btn page-action-btn--secondary" onClick={onConfigurePatients}>
              Configure patients
            </button>
          ) : null}
          <button type="button" className="schedule-cta" onClick={handleReplan} disabled={isReplanning}>
            {isReplanning ? 'Replanning...' : 'Apply Preferences / Replan'}
          </button>
        </div>
      </header>

      {lastReplan?.appliedPreferences ? (
        <section className="schedule-summary" aria-label="Planner summary">
          <h2>Planner summary</h2>
          <p>
            Doctor {lastReplan.appliedPreferences.doctorId} · Source {lastReplan.appliedPreferences.source} · Language{' '}
            {lastReplan.appliedPreferences.language}
          </p>
          <p>
            Overrides applied: {lastReplan.appliedPreferences.overridesAppliedCount} · Blocked ranges:{' '}
            {lastReplan.appliedPreferences.timeBlocksCount} · Weights: w_priority=
            {lastReplan.appliedPreferences.scoringWeights.wPriority}, w_wait=
            {lastReplan.appliedPreferences.scoringWeights.wWait}
          </p>
          {lastReplan.warnings.length > 0 ? <p>Warnings: {lastReplan.warnings.join(' · ')}</p> : null}
          <p>Header doctor id: {getDoctorId()}</p>

          {previewItems.length > 0 ? (
            <ul className="schedule-summary__list">
              {previewItems.map((item) => (
                <li key={item.scheduleItemId}>
                  <strong>
                    {item.day} {String(item.hour).padStart(2, '0')}:00
                  </strong>{' '}
                  · {item.patientName} · {item.taskName} · score {item.priorityScore.toFixed(2)}
                </li>
              ))}
            </ul>
          ) : (
            <p>No schedule items were generated.</p>
          )}
        </section>
      ) : null}

      <div className="schedule-grid-wrap">
        <div
          className="schedule-grid"
          style={{
            gridTemplateColumns: `${timeColumnWidthRem}rem repeat(${taskColumnCount}, minmax(${columnWidthRem}rem, 1fr))`,
            minWidth: `${minGridWidthRem}rem`,
          }}
        >
          <div className="corner-cell" />
          {taskColumns.length > 0 ? (
            taskColumns.map((task) => (
              <div key={task.id} className="task-cell">
                <strong>{task.name}</strong>
                <span>Task definition</span>
              </div>
            ))
          ) : (
            <div className="task-cell task-cell--empty">
              <strong>No tasks configured</strong>
              <span>Create task definitions to build this table.</span>
            </div>
          )}

          {isLoadingTasks ? (
            <>
              <div className="time-cell">--:--</div>
              <div className="slot-cell slot-cell--disabled schedule-state" style={{ gridColumn: `span ${taskColumnCount}` }}>
                Loading tasks...
              </div>
            </>
          ) : taskColumns.length === 0 ? (
            <>
              <div className="time-cell">--:--</div>
              <div className="slot-cell slot-cell--disabled schedule-state" style={{ gridColumn: `span ${taskColumnCount}` }}>
                No tasks configured yet.
              </div>
            </>
          ) : isLoading ? (
            <>
              <div className="time-cell">--:--</div>
              <div className="slot-cell slot-cell--disabled schedule-state" style={{ gridColumn: `span ${taskColumnCount}` }}>
                Loading schedule...
              </div>
            </>
          ) : timeSlots.length > 0 ? (
            timeSlots.map((slot) => (
              <Row
                key={slot}
                slot={slot}
                taskColumns={taskColumns}
                groupedItems={groupedItems}
                onDelete={handleDelete}
                showDayLabel={filterMode === 'patient'}
                isRemovingItem={isRemovingItem}
              />
            ))
          ) : (
            <>
              <div className="time-cell">--:--</div>
              <div className="slot-cell slot-cell--disabled schedule-state" style={{ gridColumn: `span ${taskColumnCount}` }}>
                No time slots in selected range.
              </div>
            </>
          )}
        </div>
      </div>
      <LoadingOverlay
        open={isRemovingItem}
        message="Reorganizing tasks and refreshing schedule..."
        ariaLabel="Reorganizing schedule"
      />
    </section>
  )
}

function createTimeSlots(start: string, end: string): string[] {
  const startMinutes = minutesFromTime(start)
  const endMinutes = minutesFromTime(end)
  const slots: string[] = []

  for (let minute = startMinutes; minute < endMinutes; minute += STEP_MINUTES) {
    slots.push(timeFromMinutes(minute))
  }

  return slots
}

function minutesFromTime(value: string): number {
  const [hours, minutes] = value.split(':').map(Number)
  return hours * 60 + minutes
}

function timeFromMinutes(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60)
    .toString()
    .padStart(2, '0')
  const minutes = (totalMinutes % 60).toString().padStart(2, '0')
  return `${hours}:${minutes}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function Row({
  slot,
  taskColumns,
  groupedItems,
  onDelete,
  showDayLabel,
  isRemovingItem,
}: {
  slot: string
  taskColumns: ScheduleTaskDefinition[]
  groupedItems: Map<string, ScheduleItem[]>
  onDelete: (scheduleItemId: string) => void
  showDayLabel: boolean
  isRemovingItem: boolean
}) {
  const slotHour = Number(slot.slice(0, 2))

  return (
    <>
      <div className="time-cell">{slot}</div>
      {taskColumns.map((task) => {
        const itemsForCell = groupedItems.get(buildCellKey(slotHour, task.name)) ?? []

        return (
          <div key={`${slot}-${task.id}`} className={`slot-cell ${itemsForCell.length > 0 ? 'slot-cell--filled' : ''}`}>
            {itemsForCell.length > 0 ? (
              <div className="schedule-card-stack">
                {itemsForCell.map((item) => {
                  const priorityTone = priorityToneFor(item.priority)
                  const cardStyle = {
                    '--patient-accent': priorityTone.accent,
                    '--patient-surface': priorityTone.surface,
                    '--patient-border': priorityTone.border,
                  } as CSSProperties

                  return (
                    <article key={item.scheduleItemId} className="schedule-card" style={cardStyle}>
                      <strong>{item.patientName}</strong>
                      <span className="schedule-card__meta">Priority {item.priority}</span>
                      {showDayLabel ? <span className="schedule-card__meta">Day {formatScheduleDay(item.day)}</span> : null}
                      <p>{item.reason}</p>
                      <button
                        type="button"
                        className="schedule-card__remove"
                        disabled={isRemovingItem}
                        onClick={() => onDelete(item.scheduleItemId)}
                        aria-label={`Remove ${item.taskName} for ${item.patientName}`}
                      >
                        Remove
                      </button>
                    </article>
                  )
                })}
              </div>
            ) : (
              <span>Open slot</span>
            )}
          </div>
        )
      })}
    </>
  )
}

function formatHour(hour: number): string {
  return `${hour.toString().padStart(2, '0')}:00`
}

function formatScheduleDay(day: string): string {
  const date = new Date(`${day}T12:00:00`)
  if (Number.isNaN(date.getTime())) return day
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}

function normalizeTaskKey(taskName: string): string {
  return taskName.trim().toLowerCase()
}

type PriorityTone = {
  accent: string
  surface: string
  border: string
}

const PRIORITY_TONES: Record<number, PriorityTone> = {
  5: { accent: '#b42318', surface: '#fff2f0', border: '#f9c8c1' },
  4: { accent: '#b54708', surface: '#fff6eb', border: '#f7d6ae' },
  3: { accent: '#1f7a3d', surface: '#effaf1', border: '#c2e9cb' },
  2: { accent: '#0f6cbd', surface: '#eff6ff', border: '#c6ddff' },
  1: { accent: '#0b5fa5', surface: '#eef6ff', border: '#c1d9ff' },
}

function priorityToneFor(priority: number): PriorityTone {
  const normalized = clamp(Math.round(priority), 1, 5)
  return PRIORITY_TONES[normalized]
}
