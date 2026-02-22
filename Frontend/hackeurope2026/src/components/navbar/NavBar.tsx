import { NavLink } from 'react-router-dom'
import './navbar.css'

const navItems: Array<{ to: string; label: string; end?: boolean }> = [
  { to: '/', label: 'Home', end: true },
  { to: '/patients', label: 'Patients' },
  { to: '/schedule', label: 'Schedule' },
  { to: '/preferences', label: 'Preferences' },
]

export default function NavBar() {
  return (
    <header className="app-navbar">
      <h1 className="app-navbar__title">Cliniclár</h1>
      <nav className="app-navbar__nav" aria-label="Main pages">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `app-navbar__link ${isActive ? 'app-navbar__link--active' : ''}`}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
    </header>
  )
}
