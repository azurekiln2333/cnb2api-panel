import { ref } from 'vue'
import { api } from './api'
import type { AuthConfig, SessionUser } from './types'

/** Public auth surface: whether key login works and how to start SSO. */
export const authConfig = ref<AuthConfig | null>(null)
/** Signed-in console identity; null while signed out. */
export const sessionUser = ref<SessionUser | null>(null)

let configPromise: Promise<AuthConfig | null> | null = null

export async function loadAuthConfig(force = false): Promise<AuthConfig | null> {
  if (!force && authConfig.value) return authConfig.value
  if (configPromise) return configPromise
  configPromise = api<AuthConfig>('/auth/config')
    .then((config) => {
      authConfig.value = config
      return config
    })
    .catch(() => null)
    .finally(() => {
      configPromise = null
    })
  return configPromise
}

export async function loadSession(): Promise<SessionUser | null> {
  try {
    const session = await api<{ authenticated: boolean; user?: SessionUser }>('/session')
    sessionUser.value = session.user ?? null
  } catch {
    sessionUser.value = null
  }
  return sessionUser.value
}

export function clearSession() {
  sessionUser.value = null
}
