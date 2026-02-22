import './ScheduleGrid.css'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { getDoctorId } from '../lib/apiClient'
import { DEFAULT_CLINICIANS } from '../types/clinician'
import type { Clinician } from '../types/clinician'
import {
  deleteScheduleItem,
  listSchedule,
  listScheduleByDay,
  listScheduleByPatient,
  replanSchedule,
  type ReplanScheduleResult,
  type ScheduleItem,
} from './scheduleApi'

type ScheduleGridProps = {
  clinicians?: Clinician[]
  onConfigurePatients?: () => void
}

const STEP_MINUTES = 30
const MIN_TIME = 0
const MAX_START_TIME = 23 * 60
const MAX_END_TIME = 23 * 60 + 30

function sortPlanItems(items: ScheduleItem[]): ScheduleItem[] {
  return [...items].sort((a, b) => {
    const dayCompare = a.day.localeCompare(b.day)
    if (dayCompare !== 0) return dayCompare
    if (a.hour !== b.hour) return a.hour - b.hour
    return a.taskName.localeCompare(b.taskName)
  })
}

export function ScheduleGrid({ clinicians = DEFAULT_CLINICIANS, onConfigurePatients }: ScheduleGridProps) {
  const activeClinicians = clinicians.length > 0 ? clinicians : DEFAULT_CLINICIANS
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('17:00')
  const [filterMode, setFilterMode] = useState<'all' | 'day' | 'patient'>('all')
  const [dayFilter, setDayFilter] = useState(() => new Date().toISOString().slice(0, 10))
  const [patientFilter, setPatientFilter] = useState('')
  const [items, setItems] = useState<ScheduleItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isReplanning, setIsReplanning] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null)
  const [lastReplan, setLastReplan] = useState<ReplanScheduleResult | null>(null)

  const timeSlots = useMemo(() => createTimeSlots(startTime, endTime), [startTime, endTime])
  const columnWidthRem = 10
  const timeColumnWidthRem = 8.5
  const clinicianCount = Math.max(activeClinicians.length, 1)
  const minGridWidthRem = timeColumnWidthRem + clinicianCount * columnWidthRem

  const previewItems = useMemo(() => {
    if (!lastReplan) return []
    return sortPlanItems(lastReplan.items).slice(0, 8)
  }, [lastReplan])

  const { slotAssignments, overflowCount } = useMemo(() => {
    const assignments = new Map<string, ScheduleItem[]>()
    const slotPatients = new Map<string, Set<string>>()
    const sorted = [...items].sort((a, b) => a.hour - b.hour || b.priorityScore - a.priorityScore)

    for (const slot of timeSlots) {
      assignments.set(slot, [])
      slotPatients.set(slot, new Set())
    }

    if (timeSlots.length === 0 || clinicianCount <= 0) {
      return {
        slotAssignments: assignments,
        overflowCount: sorted.length,
      }
    }

    const clinicStartMinutes = minutesFromTime(startTime)
    let unableToPlace = 0

    for (const item of sorted) {
      const preferredMinutes = item.hour * 60
      const preferredIndex = Math.min(
        Math.max(Math.floor((preferredMinutes - clinicStartMinutes) / STEP_MINUTES), 0),
        timeSlots.length - 1,
      )

      let placed = false
      for (let offset = 0; offset < timeSlots.length; offset += 1) {
        const slotIndex = (preferredIndex + offset) % timeSlots.length
        const slot = timeSlots[slotIndex]
        const slotItems = assignments.get(slot)
        const slotPatientKeys = slotPatients.get(slot)
        const patientKey = normalizePatientKey(item.patientName)

        if (!slotItems || !slotPatientKeys) continue
        if (slotItems.length >= clinicianCount) continue
        if (slotPatientKeys.has(patientKey)) continue

        slotItems.push(item)
        slotPatientKeys.add(patientKey)
        placed = true
        break
      }

      if (!placed) unableToPlace += 1
    }

    return {
      slotAssignments: assignments,
      overflowCount: unableToPlace,
    }
  }, [clinicianCount, items, startTime, timeSlots])

  const loadSchedule = useCallback(async () => {
    setIsLoading(true)
    setErrorMessage(null)
    try {
      const scheduleItems =
        filterMode === 'day'
          ? await listScheduleByDay(dayFilter)
          : filterMode === 'patient'
            ? await listScheduleByPatient(patientFilter.trim())
            : await listSchedule()
      setItems(scheduleItems)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load schedule.'
      setErrorMessage(message)
    } finally {
      setIsLoading(false)
    }
  }, [dayFilter, filterMode, patientFilter])

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
      setItems(result.items)
      setLastReplan(result)
      setNoticeMessage('Schedule replanned successfully.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to run planner.'
      setErrorMessage(message)
    } finally {
      setIsReplanning(false)
    }
  }

  const handleDelete = async (scheduleItemId: string) => {
    setErrorMessage(null)
    setNoticeMessage(null)

    try {
      await deleteScheduleItem(scheduleItemId)
      await loadSchedule()
      setNoticeMessage('Schedule item removed and plan refreshed.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete schedule item.'
      setErrorMessage(message)
    }
  }

  return (
    <section className="schedule" aria-label="Clinician timetable">
      <header className="schedule-header">
        <div>
          <h1>Today's Timetable</h1>
          <p>
            Times on the left, clinicians across the top. Changing clinic hours automatically reflows appointments into
            available slots.
          </p>
          <div className="time-controls" aria-label="Clinic hours">
            <label className="time-control">
              <span>Start time</span>
              <input
                type="time"
                step={STEP_MINUTES * 60}
                min="00:00"
                max="23:00"
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
                min="00:30"
                max="23:30"
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
              <select value={filterMode} onChange={(event) => setFilterMode(event.target.value as 'all' | 'day' | 'patient')}>
                <option value="all">All</option>
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
          {overflowCount > 0 ? (
            <p className="schedule-feedback schedule-feedback--warn">
              {overflowCount} appointment{overflowCount > 1 ? 's' : ''} could not fit in the selected clinic hours.
            </p>
          ) : null}
        </div>
        <div className="schedule-actions">
          <span className="clinician-count">{activeClinicians.length} clinicians</span>
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
            gridTemplateColumns: `${timeColumnWidthRem}rem repeat(${clinicianCount}, minmax(${columnWidthRem}rem, 1fr))`,
            minWidth: `${minGridWidthRem}rem`,
          }}
        >
          <div className="corner-cell" />
          {activeClinicians.length > 0 ? (
            activeClinicians.map((clinician) => (
              <div key={clinician.id} className="clinician-cell">
                <strong>{clinician.name}</strong>
                <span>{clinician.role}</span>
              </div>
            ))
          ) : (
            <div className="clinician-cell clinician-cell--empty">
              <strong>No clinicians</strong>
              <span>Add at least one clinician to fill the timetable.</span>
            </div>
          )}

          {isLoading ? (
            <>
              <div className="time-cell">--:--</div>
              <div className="slot-cell slot-cell--disabled schedule-state" style={{ gridColumn: `span ${clinicianCount}` }}>
                Loading schedule...
              </div>
            </>
          ) : timeSlots.length > 0 ? (
            timeSlots.map((slot) => (
              <Row
                key={slot}
                slot={slot}
                clinicians={activeClinicians}
                itemsForSlot={slotAssignments.get(slot) ?? []}
                onDelete={handleDelete}
              />
            ))
          ) : (
            <>
              <div className="time-cell">--:--</div>
              <div className="slot-cell slot-cell--disabled schedule-state" style={{ gridColumn: `span ${clinicianCount}` }}>
                No time slots in selected range.
              </div>
            </>
          )}
        </div>
      </div>
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
  clinicians,
  itemsForSlot,
  onDelete,
}: {
  slot: string
  clinicians: Clinician[]
  itemsForSlot: ScheduleItem[]
  onDelete: (scheduleItemId: string) => void
}) {
  return (
    <>
      <div className="time-cell">{slot}</div>
      {clinicians.length > 0 ? (
        clinicians.map((clinician, index) => {
          const item = itemsForSlot[index]
          const patientTone = item ? patientToneFor(item.patientName) : null
          const cardStyle = patientTone
            ? ({
                '--patient-accent': patientTone.accent,
                '--patient-surface': patientTone.surface,
                '--patient-border': patientTone.border,
              } as CSSProperties)
            : undefined

          return (
            <div key={`${slot}-${clinician.id}`} className={`slot-cell ${item ? 'slot-cell--filled' : ''}`}>
              {item ? (
                <article className="schedule-card" style={cardStyle}>
                  <strong>{item.taskName}</strong>
                  <span>{item.patientName}</span>
                  <span className="schedule-card__meta">Priority {item.priorityScore.toFixed(1)}</span>
                  <span className="schedule-card__meta">Original {formatHour(item.hour)}</span>
                  <p>{item.reason}</p>
                  <button
                    type="button"
                    className="schedule-card__remove"
                    onClick={() => onDelete(item.scheduleItemId)}
                    aria-label={`Remove ${item.taskName} for ${item.patientName}`}
                  >
                    Remove
                  </button>
                </article>
              ) : (
                <span>Open slot</span>
              )}
            </div>
          )
        })
      ) : (
        <button type="button" className="slot-cell slot-cell--disabled" disabled aria-label={`No clinician at ${slot}`}>
          <span>Add clinician</span>
        </button>
      )}
    </>
  )
}

function formatHour(hour: number): string {
  return `${hour.toString().padStart(2, '0')}:00`
}

function normalizePatientKey(patientName: string): string {
  return patientName.trim().toLowerCase()
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
