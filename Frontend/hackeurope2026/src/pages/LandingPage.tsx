import { Link } from 'react-router-dom'
import './landing.css'
import logoImage from '../assets/logo.jpeg'

export default function LandingPage() {
  return (
    <section className="landing-page" aria-label="Welcome">
      <article className="landing-page__card">
        <img className="landing-page__logo landing-page__logo--square" src={logoImage} alt="Cliniclar logo" />
        <p className="landing-page__eyebrow">Hospital Flow Assistant</p>
        <h1>Plan each patient journey and fill the timetable in minutes.</h1>
        <p>
          Start from patient intake or jump directly into the clinician schedule. This demo keeps both views connected
          through route-based navigation.
        </p>
        <div className="landing-page__actions">
          <Link className="page-action-btn" to="/patients">
            Start with patients
          </Link>
          <Link className="page-action-btn page-action-btn--secondary" to="/schedule">
            Open schedule
          </Link>
        </div>
      </article>
    </section>
  )
}
