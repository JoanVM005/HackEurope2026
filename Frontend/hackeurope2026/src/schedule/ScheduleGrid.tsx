import "./ScheduleGrid.css";

export type Clinician = {
  id: string;
  name: string;
  role: string;
};

type ScheduleGridProps = {
  clinicians?: Clinician[];
};

const defaultClinicians: Clinician[] = [
  { id: "clin-1", name: "Dr. Shah", role: "OT" },
  { id: "clin-2", name: "Nurse Doyle", role: "Nurse" },
  { id: "clin-3", name: "Dr. Almeida", role: "Physio" },
  { id: "clin-4", name: "Dr. Kane", role: "Doctor" },
  { id: "clin-5", name: "Dr. Jones", role: "Dietician" },
  { id: "clin-6", name: "Dr. Smith", role: "Research" },
  { id: "clin-7", name: "Mary Jane", role: "SLT" },
];

const timeSlots = [
  "08:00",
  "08:30",
  "09:00",
  "09:30",
  "10:00",
  "10:30",
  "11:00",
  "11:30",
  "12:00",
  "12:30",
  "13:00",
  "13:30",
  "14:00",
  "14:30",
  "15:00",
  "15:30",
  "16:00",
  "16:30",
];

export function ScheduleGrid({ clinicians = defaultClinicians }: ScheduleGridProps) {
  const activeClinicians = clinicians.length > 0 ? clinicians : defaultClinicians;
  const columnWidthRem = 10;
  const timeColumnWidthRem = 8.5;
  const minGridWidthRem = timeColumnWidthRem + activeClinicians.length * columnWidthRem;

  return (
    <section className="schedule" aria-label="Clinician timetable">
      <header className="schedule-header">
        <div>
          <h1>Today's Timetable</h1>
          <p>
            Times on the left, clinicians across the top. Select cells later to place patients into matching slots.
          </p>
        </div>
        <div className="schedule-actions">
          <span className="clinician-count">{activeClinicians.length} clinicians</span>
          <button type="button" className="schedule-cta">
            Run AI Schedule
          </button>
        </div>
      </header>

      <div className="schedule-grid-wrap">
        <div
          className="schedule-grid"
          style={{
            gridTemplateColumns: `${timeColumnWidthRem}rem repeat(${activeClinicians.length}, minmax(${columnWidthRem}rem, 1fr))`,
            minWidth: `${minGridWidthRem}rem`,
          }}
        >
          <div className="corner-cell" />
          {activeClinicians.map((clinician) => (
            <div key={clinician.id} className="clinician-cell">
              <strong>{clinician.name}</strong>
              <span>{clinician.role}</span>
            </div>
          ))}

          {timeSlots.map((slot) => (
            <Row key={slot} slot={slot} clinicians={activeClinicians} />
          ))}
        </div>
      </div>
    </section>
  );
}

function Row({ slot, clinicians }: { slot: string; clinicians: Clinician[] }) {
  return (
    <>
      <div className="time-cell">{slot}</div>
      {clinicians.map((clinician) => (
        <button
          key={`${slot}-${clinician.id}`}
          type="button"
          className="slot-cell"
          aria-label={`Empty slot at ${slot} for ${clinician.name}`}
        >
          <span>Open slot</span>
        </button>
      ))}
    </>
  );
}
