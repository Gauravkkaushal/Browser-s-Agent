import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('extension manifest', () => {
  const manifestPath = path.resolve(__dirname, '../../public/manifest.json')
  const iconsDir = path.resolve(__dirname, '../../public/icons')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  it('is manifest v3 and targets a Chrome new enough for the WebSocket keepalive', () => {
    expect(manifest.manifest_version).toBe(3)
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(116)
  })

  it('matches all urls, so the content script actually fires', () => {
    expect(manifest.content_scripts[0].matches).toEqual(['<all_urls>'])
    expect(manifest.host_permissions).toEqual(['<all_urls>'])
    expect(manifest.content_scripts[0].js).toEqual(['agent-content.js'])
  })

  it('requests every permission the agent genuinely uses', () => {
    for (const p of ['tabs', 'scripting', 'storage', 'webNavigation', 'debugger', 'activeTab']) {
      expect(manifest.permissions).toContain(p)
    }
  })

  it('points at the service worker that holds the WebSocket', () => {
    expect(manifest.background.service_worker).toBe('agent-background.js')
    expect(manifest.background.type).toBe('module')
  })

  it('ships both agent scripts', () => {
    for (const f of ['agent-content.js', 'agent-background.js']) {
      expect(fs.existsSync(path.resolve(__dirname, '../../public', f))).toBe(true)
    }
  })

  it('has valid icon binaries at every declared size', () => {
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    for (const size of [16, 32, 48, 128]) {
      const iconPath = path.join(iconsDir, `icon-${size}.png`)
      expect(fs.existsSync(iconPath)).toBe(true)
      const buffer = fs.readFileSync(iconPath)
      expect(buffer.subarray(0, 8)).toEqual(pngSignature)
      expect(buffer.readUInt32BE(16)).toBe(size)
      expect(buffer.readUInt32BE(20)).toBe(size)
    }
  })
})

describe('service worker keepalive contract', () => {
  const bg = fs.readFileSync(
    path.resolve(__dirname, '../../public/agent-background.js'),
    'utf8',
  )

  it('pings inside the 30s window Chrome allows', () => {
    const m = bg.match(/const KEEPALIVE_MS = (\d+)/)
    expect(m).toBeTruthy()
    expect(Number(m![1])).toBeLessThan(30000)
    expect(Number(m![1])).toBeGreaterThanOrEqual(10000)
  })

  it('reconnects with a bounded backoff', () => {
    expect(Number(bg.match(/const BACKOFF_MIN_MS = (\d+)/)![1])).toBeGreaterThanOrEqual(1000)
    expect(Number(bg.match(/const BACKOFF_MAX_MS = (\d+)/)![1])).toBeLessThanOrEqual(5000)
    expect(bg).toContain('scheduleReconnect')
  })

  it('keeps one session id across reconnects', () => {
    expect(bg).toContain('agentSessionId')
    expect(bg).toContain('chrome.storage.local')
  })

  it('refuses to close a tab it did not open', () => {
    expect(bg).toContain('refusing to close a tab the agent did not open')
  })

  it('uses the canvas only to black out sensitive regions', () => {
    expect(bg).toContain("ctx.fillStyle = '#000000'")
    expect(bg).toContain('ctx.fillRect')
  })
})
