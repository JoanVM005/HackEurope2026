const RAW_API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').trim()
if (!RAW_API_BASE) {
  throw new Error('VITE_API_BASE_URL is required for API requests.')
}
const API_PREFIX = RAW_API_BASE.replace(/\/$/, '')
const DEFAULT_DOCTOR_ID = (import.meta.env.VITE_DOCTOR_ID ?? 'demo-doctor').trim() || 'demo-doctor'

interface ApiErrorBody {
  detail?: string
}

function buildHeaders(init?: RequestInit): Headers {
  const headers = new Headers(init?.headers ?? undefined)
  const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData
  if (!isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  headers.set('X-Doctor-Id', DEFAULT_DOCTOR_ID)
  return headers
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    ...init,
    headers: buildHeaders(init),
  })

  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const body = (await response.json()) as ApiErrorBody
      if (body.detail) {
        message = body.detail
      }
    } catch {
      message = response.statusText || message
    }
    throw new Error(message)
  }

  if (response.status === 204) {
    return undefined as T
  }

  return (await response.json()) as T
}

export function getDoctorId(): string {
  return DEFAULT_DOCTOR_ID
}
