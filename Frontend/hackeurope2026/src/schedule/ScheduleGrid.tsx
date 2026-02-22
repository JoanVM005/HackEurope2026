import './ScheduleGrid.css'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import LoadingOverlay from '../components/loading-overlay/LoadingOverlay'
import { getDoctorId } from '../lib/apiClient'
import {
  applyRemoveFlow,
  cancelTaskFromRemoveFlow,
  completeScheduleItems,
  listScheduleByDay,
  listScheduleByPatient,
  listTaskDefinitions,
  replanSchedule,
  ScheduleRescheduleConflictError,
  startRemoveFlow,
  type ReplanScheduleResult,
  type RemoveFlowStartResult,
  type ScheduleItem,
  type ScheduleRescheduleOption,
  type ScheduleTaskDefinition,
} from './scheduleApi'

type ScheduleGridProps = {
  onConfigurePatients?: () => void
}

type FilterMode = 'day' | 'patient'

type ActiveRemoveFlow = {
  originalItem: ScheduleItem
  sourcePatientTaskId: string
  workingScheduleItemId: string
}

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
  const [isCompletingItems, setIsCompletingItems] = useState(false)
  const [completingItemIds, setCompletingItemIds] = useState<Set<string>>(new Set())
  const [activeRemoveFlow, setActiveRemoveFlow] = useState<ActiveRemoveFlow | null>(null)
  const [isStartingRemoveFlow, setIsStartingRemoveFlow] = useState(false)
  const [startingRemoveItemId, setStartingRemoveItemId] = useState<string | null>(null)
  const [isApplyingRemoveFlow, setIsApplyingRemoveFlow] = useState(false)
  const [isCancellingTask, setIsCancellingTask] = useState(false)
  const [rescheduleOptions, setRescheduleOptions] = useState<ScheduleRescheduleOption[]>([])
  const [selectedRescheduleOption, setSelectedRescheduleOption] = useState<string | null>(null)
  const [rescheduleError, setRescheduleError] = useState<string | null>(null)
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

  const closeRescheduleModal = (force = false) => {
    if ((isApplyingRemoveFlow || isCancellingTask) && !force) return
    setActiveRemoveFlow(null)
    setRescheduleOptions([])
    setSelectedRescheduleOption(null)
    setRescheduleError(null)
  }

  const handleStartRemoveFlow = async (item: ScheduleItem) => {
    if (isCompletingItems || isStartingRemoveFlow || isApplyingRemoveFlow || isCancellingTask) return

    setIsStartingRemoveFlow(true)
    setStartingRemoveItemId(item.scheduleItemId)
    setActiveRemoveFlow(null)
    setRescheduleOptions([])
    setSelectedRescheduleOption(null)
    setRescheduleError(null)
    setErrorMessage(null)
    setNoticeMessage(null)

    try {
      const result: RemoveFlowStartResult = await startRemoveFlow(item.scheduleItemId)
      await loadSchedule()

      setActiveRemoveFlow({
        originalItem: item,
        sourcePatientTaskId: result.sourcePatientTaskId,
        workingScheduleItemId: result.workingScheduleItemId,
      })
      setRescheduleOptions(result.options)
      setSelectedRescheduleOption(result.options[0]?.scheduledFor ?? null)
      if (result.warnings.length > 0) {
        setRescheduleError(result.warnings.join(' '))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start remove flow.'
      setErrorMessage(message)
    } finally {
      setStartingRemoveItemId(null)
      setIsStartingRemoveFlow(false)
    }
  }

  const handleConfirmReschedule = async () => {
    if (!activeRemoveFlow || !selectedRescheduleOption || isCompletingItems || isApplyingRemoveFlow || isCancellingTask) {
      return
    }

    setIsApplyingRemoveFlow(true)
    setErrorMessage(null)
    setNoticeMessage(null)
    setRescheduleError(null)

    try {
      const result = await applyRemoveFlow(activeRemoveFlow.workingScheduleItemId, selectedRescheduleOption)
      await loadSchedule()
      closeRescheduleModal(true)
      setNoticeMessage(result.notice)
    } catch (error) {
      if (error instanceof ScheduleRescheduleConflictError) {
        const warningMessage = error.warnings.length > 0 ? ` ${error.warnings.join(' ')}` : ''
        setRescheduleError(`${error.message}${warningMessage}`)
        setRescheduleOptions(error.options)
        setSelectedRescheduleOption(error.options[0]?.scheduledFor ?? null)
        return
      }
      const message = error instanceof Error ? error.message : 'Failed to reschedule item.'
      setRescheduleError(message)
    } finally {
      setIsApplyingRemoveFlow(false)
    }
  }

  const handleCancelTask = async () => {
    if (!activeRemoveFlow || isCompletingItems || isApplyingRemoveFlow || isCancellingTask) return

    setIsCancellingTask(true)
    setErrorMessage(null)
    setNoticeMessage(null)
    setRescheduleError(null)

    try {
      const result = await cancelTaskFromRemoveFlow(activeRemoveFlow.workingScheduleItemId)
      await loadSchedule()
      closeRescheduleModal(true)
      setNoticeMessage(result.notice)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to cancel task.'
      setRescheduleError(message)
    } finally {
      setIsCancellingTask(false)
    }
  }

  const handleCompleteItems = async (scheduleItemIds: string[]) => {
    if (isCompletingItems || isStartingRemoveFlow || isApplyingRemoveFlow || isCancellingTask) return

    const uniqueIds = Array.from(new Set(scheduleItemIds))
    if (uniqueIds.length === 0) return

    setIsCompletingItems(true)
    setCompletingItemIds(new Set(uniqueIds))
    setErrorMessage(null)
    setNoticeMessage(null)

    try {
      const result = await completeScheduleItems(uniqueIds)
      await loadSchedule()

      if (result.skippedIds.length > 0) {
        setNoticeMessage(
          `Completed ${result.completedIds.length} task${result.completedIds.length === 1 ? '' : 's'}, ` +
            `skipped ${result.skippedIds.length}.`,
        )
      } else {
        setNoticeMessage(`Completed ${result.completedIds.length} task${result.completedIds.length === 1 ? '' : 's'}.`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to complete schedule items.'
      setErrorMessage(message)
    } finally {
      setCompletingItemIds(new Set())
      setIsCompletingItems(false)
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
            {lastReplan.appliedPreferences.scoringWeights.wWait}, w_time_pref=
            {lastReplan.appliedPreferences.scoringWeights.wTimePref}
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
                onStartRemoveFlow={handleStartRemoveFlow}
                onCompleteItems={handleCompleteItems}
                showDayLabel={filterMode === 'patient'}
                isRescheduleBusy={isStartingRemoveFlow || isApplyingRemoveFlow || isCancellingTask}
                isCompletingItems={isCompletingItems}
                completingItemIds={completingItemIds}
                startingRemoveItemId={startingRemoveItemId}
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
      {activeRemoveFlow ? (
        <>
          <button
            type="button"
            className="schedule-reschedule__overlay"
            aria-label="Close reschedule dialog"
            onClick={() => closeRescheduleModal()}
          />
          <section className="schedule-reschedule" role="dialog" aria-modal="true" aria-label="Reschedule task">
            <header className="schedule-reschedule__header">
              <h2>Reschedule or cancel task</h2>
              <button
                type="button"
                className="schedule-reschedule__close"
                onClick={() => closeRescheduleModal()}
                disabled={isApplyingRemoveFlow || isCancellingTask}
              >
                <span aria-hidden>×</span>
              </button>
            </header>
            <p className="schedule-reschedule__hint">
              Task temporarily rescheduled after replan. Choose final slot or cancel task for{' '}
              {activeRemoveFlow.originalItem.taskName} · {activeRemoveFlow.originalItem.patientName}.
            </p>
            {rescheduleError ? <p className="schedule-reschedule__error">{rescheduleError}</p> : null}
            {rescheduleOptions.length > 0 ? (
              <fieldset className="schedule-reschedule__options" disabled={isApplyingRemoveFlow || isCancellingTask}>
                {rescheduleOptions.map((option) => (
                  <label key={option.scheduledFor} className="schedule-reschedule__option">
                    <input
                      type="radio"
                      name="reschedule-option"
                      checked={selectedRescheduleOption === option.scheduledFor}
                      onChange={() => setSelectedRescheduleOption(option.scheduledFor)}
                    />
                    <span>
                      {formatScheduleDay(option.day)} · {formatHour(option.hour)}
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : (
              <p className="schedule-reschedule__state">No available consecutive slots found.</p>
            )}
            <footer className="schedule-reschedule__actions">
              <button
                type="button"
                className="card-btn"
                onClick={() => closeRescheduleModal()}
                disabled={isApplyingRemoveFlow || isCancellingTask}
              >
                Close
              </button>
              <button
                type="button"
                className="card-btn card-btn--danger"
                onClick={handleCancelTask}
                disabled={isApplyingRemoveFlow || isCancellingTask}
              >
                {isCancellingTask ? 'Cancelling...' : 'Cancel task'}
              </button>
              <button
                type="button"
                className="card-btn card-btn--primary"
                onClick={handleConfirmReschedule}
                disabled={isApplyingRemoveFlow || isCancellingTask || !selectedRescheduleOption}
              >
                {isApplyingRemoveFlow ? 'Rescheduling...' : 'Reschedule'}
              </button>
            </footer>
          </section>
        </>
      ) : null}
      <LoadingOverlay
        open={isCompletingItems || isStartingRemoveFlow || isApplyingRemoveFlow || isCancellingTask}
        message={
          isCompletingItems
            ? 'Completing tasks and refreshing schedule...'
            : isStartingRemoveFlow
              ? 'Replanning task and preparing consecutive slots...'
              : isCancellingTask
                ? 'Cancelling task and refreshing schedule...'
                : 'Applying selected schedule slot...'
        }
        ariaLabel={
          isCompletingItems
            ? 'Completing schedule items'
            : isStartingRemoveFlow
              ? 'Preparing remove flow'
              : isCancellingTask
                ? 'Cancelling task'
                : 'Applying remove flow slot'
        }
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
  onStartRemoveFlow,
  onCompleteItems,
  showDayLabel,
  isRescheduleBusy,
  isCompletingItems,
  completingItemIds,
  startingRemoveItemId,
}: {
  slot: string
  taskColumns: ScheduleTaskDefinition[]
  groupedItems: Map<string, ScheduleItem[]>
  onStartRemoveFlow: (item: ScheduleItem) => void
  onCompleteItems: (scheduleItemIds: string[]) => void
  showDayLabel: boolean
  isRescheduleBusy: boolean
  isCompletingItems: boolean
  completingItemIds: Set<string>
  startingRemoveItemId: string | null
}) {
  const slotHour = Number(slot.slice(0, 2))
  const rowPendingItemIds = taskColumns
    .flatMap((task) => groupedItems.get(buildCellKey(slotHour, task.name)) ?? [])
    .filter((item) => item.status === 'pending')
    .map((item) => item.scheduleItemId)

  return (
    <>
      <div className="time-cell time-cell--with-actions">
        <span>{slot}</span>
        <button
          type="button"
          className="time-cell__complete-all"
          disabled={rowPendingItemIds.length === 0 || isRescheduleBusy || isCompletingItems}
          onClick={() => onCompleteItems(rowPendingItemIds)}
        >
          Mark all as completed
        </button>
      </div>
      {taskColumns.map((task) => {
        const itemsForCell = groupedItems.get(buildCellKey(slotHour, task.name)) ?? []
        const isCellCompleted = itemsForCell.length > 0 && itemsForCell.every((item) => item.status === 'completed')

        return (
          <div
            key={`${slot}-${task.id}`}
            className={`slot-cell ${itemsForCell.length > 0 ? 'slot-cell--filled' : ''} ${isCellCompleted ? 'slot-cell--completed' : ''}`}
          >
            {itemsForCell.length > 0 ? (
              <div className="schedule-card-stack">
                {itemsForCell.map((item) => {
                  const isCompleted = item.status === 'completed'
                  const isCompletingThisCard = completingItemIds.has(item.scheduleItemId)
                  const isStartingThisCard = startingRemoveItemId === item.scheduleItemId
                  const patientTone = patientToneFor(item.patientName)
                  const cardStyle = {
                    '--patient-accent': patientTone.accent,
                    '--patient-surface': patientTone.surface,
                    '--patient-border': patientTone.border,
                  } as CSSProperties

                  return (
                    <article
                      key={item.scheduleItemId}
                      className={`schedule-card ${isCompleted ? 'schedule-card--completed' : ''}`}
                      style={cardStyle}
                    >
                      <strong>{item.patientName}</strong>
                      <span className="schedule-card__meta">Priority {item.priorityScore.toFixed(1)}</span>
                      <span className="schedule-card__meta">Original {formatHour(item.hour)}</span>
                      {showDayLabel ? <span className="schedule-card__meta">Day {formatScheduleDay(item.day)}</span> : null}
                      <p>{item.reason}</p>
                      <button
                        type="button"
                        className="schedule-card__complete"
                        disabled={isCompleted || isRescheduleBusy || isCompletingItems}
                        onClick={() => onCompleteItems([item.scheduleItemId])}
                        aria-label={`Mark ${item.taskName} for ${item.patientName} as completed`}
                      >
                        {isCompletingThisCard ? 'Completing...' : 'Completed'}
                      </button>
                      {!isCompleted ? (
                        <button
                          type="button"
                          className="schedule-card__remove"
                          disabled={isRescheduleBusy || isCompletingItems || isStartingThisCard}
                          onClick={() => onStartRemoveFlow(item)}
                          aria-label={`Reschedule ${item.taskName} for ${item.patientName}`}
                        >
                          {isStartingThisCard ? 'Replanning...' : 'Remove'}
                        </button>
                      ) : null}
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

type PatientTone = {
  accent: string
  surface: string
  border: string
}

const PATIENT_TONES: PatientTone[] = [
  { accent: '#b42318', surface: '#fff2f0', border: '#f9c8c1' },
  { accent: '#b54708', surface: '#fff6eb', border: '#f7d6ae' },
  { accent: '#1f7a3d', surface: '#effaf1', border: '#c2e9cb' },
  { accent: '#0f6cbd', surface: '#eff6ff', border: '#c6ddff' },
  { accent: '#6e49cb', surface: '#f4f0ff', border: '#d8caf8' },
  { accent: '#ad2454', surface: '#fff0f6', border: '#f6c7dc' },
  { accent: '#007a7a', surface: '#edfbfb', border: '#c2ebeb' },
  { accent: '#6a4c1e', surface: '#faf5ee', border: '#e8d9c1' },
]

function patientToneFor(patientName: string): PatientTone {
  let hash = 0
  for (let i = 0; i < patientName.length; i += 1) {
    hash = (hash * 31 + patientName.charCodeAt(i)) >>> 0
  }
  return PATIENT_TONES[hash % PATIENT_TONES.length]
}
