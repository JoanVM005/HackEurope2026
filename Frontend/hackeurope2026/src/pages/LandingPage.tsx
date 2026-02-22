import { Link } from 'react-router-dom'
import './landing.css'

export default function LandingPage() {
  return (
    <section className="landing-page" aria-label="Project overview">
      <div className="landing-page__container">
        <header className="landing-page__hero">
          <p className="landing-page__eyebrow">HackEurope 2026 Demo</p>
          <h1>Patient intake and scheduling in one connected workflow.</h1>
          <p>
            This landing summarizes what is already implemented in the product and supports a short live presentation
            of the current MVP.
          </p>
          <div className="landing-page__actions">
            <Link className="page-action-btn" to="/patients">
              Start with Patients
            </Link>
            <Link className="page-action-btn" to="/schedule">
              Open Schedule
            </Link>
            <Link className="page-action-btn page-action-btn--secondary" to="/preferences">
              Configure Preferences
            </Link>
          </div>
        </header>

        <section className="landing-page__grid" aria-label="Current implementation">
          <article className="landing-page__card">
            <h2>What the platform does now</h2>
            <ul>
              <li>Create and edit patient records with ID, admission context, and timing details.</li>
              <li>Assign required tasks from a shared catalog directly from the patient workflow.</li>
              <li>Open a schedule view, replan in one click, and inspect priority reasons.</li>
              <li>Filter schedules by full list, by day, or by specific patient.</li>
              <li>Remove schedule items and trigger automatic refresh of the plan.</li>
            </ul>
          </article>

          <article className="landing-page__card">
            <h2>What is already built (Frontend + Backend)</h2>
            <ul>
              <li>React + TypeScript frontend with dedicated pages for Patients, Schedule, and Preferences.</li>
              <li>FastAPI backend with endpoints for patients, tasks, schedule planning, and preferences.</li>
              <li>Supabase/PostgreSQL persistence for patients, task definitions, patient tasks, and schedule items.</li>
              <li>Planner output includes scored items, applied preference summary, and warnings.</li>
              <li>Doctor-specific preferences are handled through the `X-Doctor-Id` request header.</li>
            </ul>
          </article>

          <article className="landing-page__card landing-page__card--wide">
            <h2>How to demo it in under 2 minutes</h2>
            <ol>
              <li>Open Patients, add one patient with tasks, then confirm it appears in the board.</li>
              <li>Open Schedule, run replan, and show the generated items with priority reasoning.</li>
              <li>Open Preferences, update one rule, return to Schedule, and replan to show impact.</li>
            </ol>
          </article>
        </section>
      </div>
    </section>
  )
}
