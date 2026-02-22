export type MatchType = 'contains' | 'regex'
export type PreferenceLanguage = 'es' | 'en'

export interface TimeBlock {
  start: string
  end: string
}

export interface PriorityOverrideRule {
  match_type: MatchType
  pattern: string
  priority: number
  enabled: boolean
}

export interface ScoringWeights {
  w_priority: number
  w_wait: number
  w_time_pref: number
}

export interface ExplanationPreferences {
  include_reason: boolean
  include_formula: boolean
}

export interface PlannerPreferences {
  time_blocks: TimeBlock[]
  priority_overrides: PriorityOverrideRule[]
  scoring_weights: ScoringWeights
  language: PreferenceLanguage
  explanations: ExplanationPreferences
}

export interface PreferencesResponse {
  doctor_id: string
  source: 'mem0' | 'default'
  preferences: PlannerPreferences
  warnings: string[]
}

export interface PlannerPreferencesUpdate {
  time_blocks?: TimeBlock[]
  priority_overrides?: PriorityOverrideRule[]
  scoring_weights?: ScoringWeights
  language?: PreferenceLanguage
  explanations?: ExplanationPreferences
}
