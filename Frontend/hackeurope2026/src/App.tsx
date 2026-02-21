import './App.css'
import { useState } from 'react'
import PatientBoardPage from './features/patient-board/PatientBoardPage'
import { ScheduleGrid } from './schedule/ScheduleGrid'
import { DEFAULT_CLINICIANS } from './types/clinician'
import type { Clinician } from './types/clinician'

type Screen = 'landing' | 'patients' | 'schedule'

function App() {
  const [screen, setScreen] = useState<Screen>('landing')
  const [clinicians, setClinicians] = useState<Clinician[]>(DEFAULT_CLINICIANS)

  if (screen === 'landing') {
    return (
      <main className="app-shell app-shell--landing">
        <section className="landing" aria-label="Demo start">
          <div className="landing__panel">
            <p className="landing__eyebrow">ClinicFlow</p>
            <h1>Clinical Scheduling, Reimagined</h1>
            <p className="landing__subtitle">
              Build the patient queue, select present clinicians, and generate an optimised timetable in seconds.
            </p>

            <div className="landing__chips" aria-label="Platform highlights">
              <span>Patient-first flow</span>
              <span>Dynamic clinicians</span>
              <span>AI-ready schedule</span>
            </div>

            <div className="landing__actions">
              <button type="button" className="page-action-btn landing__cta" onClick={() => setScreen('patients')}>
                Start demo!
              </button>
              <span className="landing__hint">No setup required</span>
            </div>
          </div>
        </section>
      </main>
    )
  }

  if (screen === 'patients') {
    return (
      <main className="app-shell">
        <PatientBoardPage
          clinicians={clinicians}
          onCliniciansChange={setClinicians}
          onCreateSchedule={() => setScreen('schedule')}
        />
      </main>
    )
  }

  return (
    <main className="app-shell">
      <ScheduleGrid clinicians={clinicians} onConfigurePatients={() => setScreen('patients')} />
    </main>
  )
}

export default App
