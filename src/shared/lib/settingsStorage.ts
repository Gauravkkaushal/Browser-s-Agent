import type { UserSettings } from '../types/netrashield'

export const DEFAULT_SETTINGS: UserSettings = {
  reasoningEngine: 'auto',
  serverUrl: 'http://localhost:8787/reason',
  privacyMode: 'balanced',
}

const STORAGE_KEY = 'netrashield_user_settings'

type ChromeWithStorage = {
  storage?: {
    sync?: {
      get: (keys: Record<string, unknown>, callback: (items: Record<string, unknown>) => void) => void
      set: (items: Record<string, unknown>, callback?: () => void) => void
    }
  }
}

declare const chrome: ChromeWithStorage | undefined

function hasChromeStorageSync(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome?.storage?.sync)
}

export async function loadSettings(): Promise<UserSettings> {
  if (hasChromeStorageSync()) {
    return new Promise((resolve) => {
      try {
        chrome!.storage!.sync!.get(DEFAULT_SETTINGS, (items) => {
          if (items && typeof items === 'object') {
            resolve({
              reasoningEngine: (items.reasoningEngine as UserSettings['reasoningEngine']) || DEFAULT_SETTINGS.reasoningEngine,
              serverUrl: (items.serverUrl as string) || DEFAULT_SETTINGS.serverUrl,
              privacyMode: (items.privacyMode as UserSettings['privacyMode']) || DEFAULT_SETTINGS.privacyMode,
            })
          } else {
            resolve(DEFAULT_SETTINGS)
          }
        })
      } catch (err) {
        console.warn('[NetraShield] Failed to load chrome.storage.sync settings:', err)
        resolve(loadFromLocalStorage())
      }
    })
  }

  return loadFromLocalStorage()
}

export async function saveSettings(partial: Partial<UserSettings>): Promise<UserSettings> {
  const current = await loadSettings()
  const updated: UserSettings = { ...current, ...partial }

  if (hasChromeStorageSync()) {
    return new Promise((resolve) => {
      try {
        chrome!.storage!.sync!.set(updated, () => {
          saveToLocalStorage(updated)
          resolve(updated)
        })
      } catch (err) {
        console.warn('[NetraShield] Failed to save to chrome.storage.sync:', err)
        saveToLocalStorage(updated)
        resolve(updated)
      }
    })
  }

  saveToLocalStorage(updated)
  return updated
}

let inMemorySettings: UserSettings | null = null

function loadFromLocalStorage(): UserSettings {
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) }
      }
    }
  } catch (err) {
    console.warn('[NetraShield] Error reading localStorage:', err)
  }
  return inMemorySettings ? { ...DEFAULT_SETTINGS, ...inMemorySettings } : { ...DEFAULT_SETTINGS }
}

function saveToLocalStorage(settings: UserSettings): void {
  inMemorySettings = { ...settings }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    }
  } catch (err) {
    console.warn('[NetraShield] Error writing to localStorage:', err)
  }
}

export function _resetSettingsForTesting(): void {
  inMemorySettings = null
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.clear()
    }
  } catch {}
}
