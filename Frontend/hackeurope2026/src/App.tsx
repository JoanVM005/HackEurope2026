import './App.css'
import { useState } from 'react'
import PatientBoardPage from './features/patient-board/PatientBoardPage'
import { ScheduleGrid } from './schedule/ScheduleGrid'

type Screen = 'landing' | 'patients' | 'schedule'

function App() {
  const [screen, setScreen] = useState<Screen>('landing')

  if (screen === 'landing') {
    return (
      <main className="app-shell app-shell--landing">
        <section className="landing" aria-label="Demo start">
          <button type="button" className="page-action-btn" onClick={() => setScreen('patients')}>
            Start demo
          </button>
        </section>
      </main>
    )
  }

  if (screen === 'patients') {
    return (
      <main className="app-shell">
        <PatientBoardPage onCreateSchedule={() => setScreen('schedule')} />
      </main>
    )
  }

  return (
    <main className="app-shell">
      <ScheduleGrid onConfigurePatients={() => setScreen('patients')} />
    </main>
  )
}

export default App
