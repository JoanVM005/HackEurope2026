import { Outlet } from 'react-router-dom'
import NavBar from '../components/navbar/NavBar'
import './appLayout.css'

export default function AppLayout() {
  return (
    <div className="app-layout">
      <NavBar />
      <main className="app-layout__page">
        <Outlet />
      </main>
    </div>
  )
}
