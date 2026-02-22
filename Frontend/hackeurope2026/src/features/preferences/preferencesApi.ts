import { apiRequest } from '../../lib/apiClient'
import type { PlannerPreferencesUpdate, PreferencesResponse } from './types'

export async function getPreferences(): Promise<PreferencesResponse> {
  return apiRequest<PreferencesResponse>('/preferences')
}

export async function savePreferences(payload: PlannerPreferencesUpdate): Promise<PreferencesResponse> {
  return apiRequest<PreferencesResponse>('/preferences', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
