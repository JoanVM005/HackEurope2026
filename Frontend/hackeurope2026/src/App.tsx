import PatientBoardPage from './features/patient-board/PatientBoardPage'
import './App.css'
import { ScheduleGrid } from './schedule/ScheduleGrid'

function App() {
  return (
    <main className="app-shell">
      <ScheduleGrid />
    </main>
  )
  return <PatientBoardPage />
}

export default App
