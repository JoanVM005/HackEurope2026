import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import PatientBoardPage from '../features/patient-board/PatientBoardPage'
import PreferencesPage from '../features/preferences/PreferencesPage'
import AppLayout from '../layout/AppLayout'
import LandingPage from '../pages/LandingPage'
import { ScheduleGrid } from '../schedule/ScheduleGrid'

function PatientsRoute() {
  const navigate = useNavigate()

  return <PatientBoardPage onCreateSchedule={() => navigate('/schedule')} />
}

function ScheduleRoute() {
  const navigate = useNavigate()

  return <ScheduleGrid onConfigurePatients={() => navigate('/patients')} />
}

export default function AppRouter() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<LandingPage />} />
        <Route path="/patients" element={<PatientsRoute />} />
        <Route path="/schedule" element={<ScheduleRoute />} />
        <Route path="/preferences" element={<PreferencesPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
