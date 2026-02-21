import "./ScheduleGrid.css";
import { useMemo, useState } from "react";
import { DEFAULT_CLINICIANS } from "../types/clinician";
import type { Clinician } from "../types/clinician";

type ScheduleGridProps = {
  clinicians?: Clinician[];
  onConfigurePatients?: () => void;
};

const STEP_MINUTES = 30;
const MIN_TIME = 0;
const MAX_START_TIME = 23 * 60;
const MAX_END_TIME = 23 * 60 + 30;

export function ScheduleGrid({ clinicians = DEFAULT_CLINICIANS, onConfigurePatients }: ScheduleGridProps) {
  const activeClinicians = clinicians.length > 0 ? clinicians : DEFAULT_CLINICIANS;
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");
  const timeSlots = useMemo(() => createTimeSlots(startTime, endTime), [startTime, endTime]);
  const columnWidthRem = 10;
  const timeColumnWidthRem = 8.5;
  const clinicianCount = Math.max(activeClinicians.length, 1);
  const minGridWidthRem = timeColumnWidthRem + clinicianCount * columnWidthRem;

  return (
    <section className="schedule" aria-label="Clinician timetable">
      <header className="schedule-header">
        <div>
          <h1>Today's Timetable</h1>
          <p>
            Times on the left, clinicians across the top. Select cells later to place patients into matching slots.
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
                  const newStart = clamp(minutesFromTime(event.target.value), MIN_TIME, MAX_START_TIME);
                  const currentEnd = minutesFromTime(endTime);
                  const correctedEnd =
                    newStart < currentEnd ? currentEnd : clamp(newStart + STEP_MINUTES, STEP_MINUTES, MAX_END_TIME);

                  setStartTime(timeFromMinutes(newStart));
                  setEndTime(timeFromMinutes(correctedEnd));
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
                  const newEnd = clamp(minutesFromTime(event.target.value), STEP_MINUTES, MAX_END_TIME);
                  const currentStart = minutesFromTime(startTime);
                  const correctedStart =
                    newEnd > currentStart ? currentStart : clamp(newEnd - STEP_MINUTES, MIN_TIME, MAX_START_TIME);

                  setEndTime(timeFromMinutes(newEnd));
                  setStartTime(timeFromMinutes(correctedStart));
                }}
              />
            </label>
          </div>
        </div>
        <div className="schedule-actions">
          <span className="clinician-count">{activeClinicians.length} clinicians</span>
          {onConfigurePatients ? (
            <button type="button" className="page-action-btn page-action-btn--secondary" onClick={onConfigurePatients}>
              Configure patients
            </button>
          ) : null}
          <button type="button" className="schedule-cta">
            Run AI Schedule
          </button>
        </div>
      </header>

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

          {timeSlots.map((slot) => (
            <Row key={slot} slot={slot} clinicians={activeClinicians} />
          ))}
        </div>
      </div>
    </section>
  );
}

function createTimeSlots(start: string, end: string): string[] {
  const startMinutes = minutesFromTime(start);
  const endMinutes = minutesFromTime(end);
  const slots: string[] = [];

  for (let minute = startMinutes; minute < endMinutes; minute += STEP_MINUTES) {
    slots.push(timeFromMinutes(minute));
  }

  return slots;
}

function minutesFromTime(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function timeFromMinutes(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (totalMinutes % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function Row({ slot, clinicians }: { slot: string; clinicians: Clinician[] }) {
  return (
    <>
      <div className="time-cell">{slot}</div>
      {clinicians.length > 0 ? (
        clinicians.map((clinician) => (
          <button
            key={`${slot}-${clinician.id}`}
            type="button"
            className="slot-cell"
            aria-label={`Empty slot at ${slot} for ${clinician.name}`}
          >
            <span>Open slot</span>
          </button>
        ))
      ) : (
        <button type="button" className="slot-cell slot-cell--disabled" disabled aria-label={`No clinician at ${slot}`}>
          <span>Add clinician</span>
        </button>
      )}
    </>
  );
}
