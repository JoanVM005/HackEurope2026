import { useEffect, useMemo, useState } from 'react'
import { getDoctorId } from '../../lib/apiClient'
import { getPreferences, savePreferences } from './preferencesApi'
import type {
  PlannerPreferences,
  PriorityOverrideRule,
  TimeBlock,
} from './types'
import './preferences.css'

const DEFAULT_PREFERENCES: PlannerPreferences = {
  time_blocks: [],
  priority_overrides: [],
  scoring_weights: {
    w_priority: 10,
    w_wait: 0.05,
  },
  language: 'en',
  explanations: {
    include_reason: true,
    include_formula: false,
  },
}

function newTimeBlock(): TimeBlock {
  return { start: '13:00', end: '14:00' }
}

function newOverride(): PriorityOverrideRule {
  return { match_type: 'contains', pattern: '', priority: 5, enabled: true }
}

export default function PreferencesPage() {
  const [preferences, setPreferences] = useState<PlannerPreferences>(DEFAULT_PREFERENCES)
  const [source, setSource] = useState<'mem0' | 'default'>('default')
  const [warnings, setWarnings] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true

    const load = async () => {
      setIsLoading(true)
      setErrorMessage(null)
      try {
        const response = await getPreferences()
        if (!mounted) return
        setPreferences({
          ...response.preferences,
          language: 'en',
        })
        setSource(response.source)
        setWarnings(response.warnings)
      } catch (error) {
        if (!mounted) return
        const message = error instanceof Error ? error.message : 'Failed to load preferences.'
        setErrorMessage(message)
      } finally {
        if (mounted) {
          setIsLoading(false)
        }
      }
    }

    void load()

    return () => {
      mounted = false
    }
  }, [])

  const warningText = useMemo(() => warnings.join(' · '), [warnings])

  const updateTimeBlock = (index: number, patch: Partial<TimeBlock>) => {
    setPreferences((current) => ({
      ...current,
      time_blocks: current.time_blocks.map((timeBlock, i) => (i === index ? { ...timeBlock, ...patch } : timeBlock)),
    }))
  }

  const removeTimeBlock = (index: number) => {
    setPreferences((current) => ({
      ...current,
      time_blocks: current.time_blocks.filter((_, i) => i !== index),
    }))
  }

  const updateOverride = (index: number, patch: Partial<PriorityOverrideRule>) => {
    setPreferences((current) => ({
      ...current,
      priority_overrides: current.priority_overrides.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
    }))
  }

  const removeOverride = (index: number) => {
    setPreferences((current) => ({
      ...current,
      priority_overrides: current.priority_overrides.filter((_, i) => i !== index),
    }))
  }

  const save = async () => {
    if (isSaving) return
    setIsSaving(true)
    setErrorMessage(null)
    setNoticeMessage(null)

    try {
      const response = await savePreferences({
        ...preferences,
        language: 'en',
      })
      setPreferences({
        ...response.preferences,
        language: 'en',
      })
      setSource(response.source)
      setWarnings(response.warnings)
      setNoticeMessage('Preferences saved successfully.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save preferences.'
      setErrorMessage(message)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <section className="preferences-page" aria-label="Planner preferences">
      <header className="preferences-page__header">
        <h1>Planner Preferences</h1>
        <p>Doctor memory profile used for schedule generation.</p>
        <div className="preferences-page__meta">
          <span>Doctor: {getDoctorId()}</span>
          <span>Source: {source}</span>
        </div>
      </header>

      {errorMessage ? <p className="preferences-page__feedback preferences-page__feedback--error">{errorMessage}</p> : null}
      {noticeMessage ? <p className="preferences-page__feedback preferences-page__feedback--notice">{noticeMessage}</p> : null}
      {warningText ? <p className="preferences-page__feedback preferences-page__feedback--warning">{warningText}</p> : null}

      {isLoading ? (
        <p className="preferences-page__loading">Loading preferences...</p>
      ) : (
        <>
          <section className="preferences-card">
            <header>
              <div className="preferences-card__title-wrap">
                <h2>Time Blocks</h2>
                <p className="preferences-card__description">
                  Time ranges where the planner must avoid scheduling tasks.
                </p>
              </div>
              <button
                type="button"
                className="page-action-btn page-action-btn--secondary"
                onClick={() => setPreferences((current) => ({ ...current, time_blocks: [...current.time_blocks, newTimeBlock()] }))}
              >
                Add block
              </button>
            </header>
            {preferences.time_blocks.length === 0 ? <p className="preferences-empty">No blocked ranges configured.</p> : null}
            {preferences.time_blocks.map((timeBlock, index) => (
              <div key={`${timeBlock.start}-${timeBlock.end}-${index}`} className="preferences-row">
                <input
                  type="time"
                  value={timeBlock.start}
                  onChange={(event) => updateTimeBlock(index, { start: event.target.value })}
                />
                <span>to</span>
                <input
                  type="time"
                  value={timeBlock.end}
                  onChange={(event) => updateTimeBlock(index, { end: event.target.value })}
                />
                <button type="button" className="card-btn card-btn--danger" onClick={() => removeTimeBlock(index)}>
                  Remove
                </button>
              </div>
            ))}
          </section>

          <section className="preferences-card">
            <header>
              <div className="preferences-card__title-wrap">
                <h2>Priority Overrides (Patient Description)</h2>
                <p className="preferences-card__description">
                  Boost priority when patient description text matches a rule.
                </p>
              </div>
              <button
                type="button"
                className="page-action-btn page-action-btn--secondary"
                onClick={() =>
                  setPreferences((current) => ({
                    ...current,
                    priority_overrides: [...current.priority_overrides, newOverride()],
                  }))
                }
              >
                Add override
              </button>
            </header>
            {preferences.priority_overrides.length === 0 ? <p className="preferences-empty">No override rules configured.</p> : null}
            {preferences.priority_overrides.map((rule, index) => (
              <div key={`${rule.pattern}-${index}`} className="preferences-override-row">
                <select
                  value={rule.match_type}
                  onChange={(event) => updateOverride(index, { match_type: event.target.value as 'contains' | 'regex' })}
                >
                  <option value="contains">contains</option>
                  <option value="regex">regex</option>
                </select>
                <input
                  type="text"
                  placeholder="Pattern in patient description"
                  value={rule.pattern}
                  onChange={(event) => updateOverride(index, { pattern: event.target.value })}
                />
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={rule.priority}
                  onChange={(event) => updateOverride(index, { priority: Number(event.target.value) })}
                />
                <label>
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={(event) => updateOverride(index, { enabled: event.target.checked })}
                  />
                  Enabled
                </label>
                <button type="button" className="card-btn card-btn--danger" onClick={() => removeOverride(index)}>
                  Remove
                </button>
              </div>
            ))}
          </section>

          <section className="preferences-card preferences-card--compact">
            <h2>Scoring</h2>
            <p className="preferences-card__description">
              Controls how much priority and waiting time affect final score.
            </p>
            <div className="preferences-row">
              <label>
                w_priority
                <input
                  type="number"
                  min={1}
                  max={20}
                  step={0.1}
                  value={preferences.scoring_weights.w_priority}
                  onChange={(event) =>
                    setPreferences((current) => ({
                      ...current,
                      scoring_weights: {
                        ...current.scoring_weights,
                        w_priority: Number(event.target.value),
                      },
                    }))
                  }
                />
              </label>
              <label>
                w_wait
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={preferences.scoring_weights.w_wait}
                  onChange={(event) =>
                    setPreferences((current) => ({
                      ...current,
                      scoring_weights: {
                        ...current.scoring_weights,
                        w_wait: Number(event.target.value),
                      },
                    }))
                  }
                />
              </label>
            </div>
          </section>

          <footer className="preferences-page__footer">
            <button type="button" className="page-action-btn" onClick={save} disabled={isSaving}>
              {isSaving ? 'Saving...' : 'Save preferences'}
            </button>
          </footer>
        </>
      )}
    </section>
  )
}
