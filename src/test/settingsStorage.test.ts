import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, _resetSettingsForTesting, loadSettings, saveSettings } from '../shared/lib/settingsStorage'

describe('NetraShield Settings Storage', () => {
  beforeEach(() => {
    _resetSettingsForTesting()
  })

  it('loads default settings when empty', async () => {
    const settings = await loadSettings()
    expect(settings).toEqual(DEFAULT_SETTINGS)
    expect(settings.reasoningEngine).toBe('auto')
    expect(settings.serverUrl).toBe('http://localhost:8787/reason')
    expect(settings.privacyMode).toBe('balanced')
  })

  it('persists changes to reasoningEngine', async () => {
    const updated = await saveSettings({ reasoningEngine: 'onnx' })
    expect(updated.reasoningEngine).toBe('onnx')

    const reloaded = await loadSettings()
    expect(reloaded.reasoningEngine).toBe('onnx')
    expect(reloaded.serverUrl).toBe(DEFAULT_SETTINGS.serverUrl)
  })

  it('persists changes to serverUrl', async () => {
    const customUrl = 'https://ai.internal.isro.gov.in/reason'
    await saveSettings({ serverUrl: customUrl, reasoningEngine: 'server' })

    const reloaded = await loadSettings()
    expect(reloaded.serverUrl).toBe(customUrl)
    expect(reloaded.reasoningEngine).toBe('server')
  })
})
