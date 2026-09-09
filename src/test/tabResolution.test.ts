import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Which tab the agent works in, tested against the REAL service-worker source.
 *
 * This has now broken twice, both times invisibly: the code looks correct in
 * isolation and only fails in the one arrangement nobody reproduces by hand --
 * the agent's own detached window is focused, so `lastFocusedWindow`'s active
 * tab is a chrome-extension:// page, and the real web page is one tab away.
 * Running the shipped function against a fake `chrome` is the only way to keep
 * that arrangement covered.
 */
const SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../../public/agent-background.js'),
  'utf8',
)

type Tab = { id: number; url: string; active?: boolean; lastAccessed?: number }

function loadResolver(tabs: Tab[]) {
  // Pull the two functions under test out of the shipped file, so the test
  // cannot drift away from what actually runs in Chrome.
  const isInjectable = SOURCE.slice(
    SOURCE.indexOf('function isInjectable(url)'),
    SOURCE.indexOf('async function resolveTabId'),
  )
  const resolveTabId = SOURCE.slice(
    SOURCE.indexOf('async function resolveTabId'),
    SOURCE.indexOf('async function ensureContentScript'),
  )

  const chrome = {
    tabs: {
      query: async (q: { active?: boolean }) =>
        q && q.active ? tabs.filter((t) => t.active) : tabs.slice(),
      get: async (id: number) => {
        const found = tabs.find((t) => t.id === id)
        if (!found) throw new Error('no tab ' + id)
        return found
      },
    },
    storage: { session: { get: async () => ({}), set: async () => undefined } },
  }

  const make = new Function(
    'chrome',
    `let currentTabId = null;
     const agentOwnedTabs = new Set();
     async function rememberCurrentTab(id) { currentTabId = id }
     async function recallCurrentTab() { return currentTabId }
     ${isInjectable}
     ${resolveTabId}
     return { resolveTabId, isInjectable };`,
  )
  return make(chrome) as {
    resolveTabId: (requested?: number | null) => Promise<number>
    isInjectable: (url: string) => boolean
  }
}

describe('isInjectable', () => {
  it('accepts ordinary web pages', () => {
    const { isInjectable } = loadResolver([])
    expect(isInjectable('https://web.whatsapp.com/')).toBe(true)
    expect(isInjectable('http://lms.kiet.edu/moodle/my/')).toBe(true)
  })

  it("rejects pages an extension cannot read, including the agent's own", () => {
    const { isInjectable } = loadResolver([])
    expect(isInjectable('chrome-extension://abc/index.html')).toBe(false)
    expect(isInjectable('chrome://extensions')).toBe(false)
    expect(isInjectable('')).toBe(false)
  })
})

describe('resolveTabId', () => {
  beforeEach(() => vi.clearAllMocks())

  it('uses the active tab when it is an ordinary page', async () => {
    const { resolveTabId } = loadResolver([
      { id: 1, url: 'https://web.whatsapp.com/', active: true },
      { id: 2, url: 'https://amazon.in/', lastAccessed: 5 },
    ])
    await expect(resolveTabId(null)).resolves.toBe(1)
  })

  it("falls through to the real page when the agent's own window is focused", async () => {
    // The regression, exactly: starting a task from the detached window made
    // its chrome-extension:// page the active tab, and the agent gave up with
    // "cannot operate on this page" while WhatsApp sat open beside it.
    const { resolveTabId } = loadResolver([
      { id: 9, url: 'chrome-extension://abc/index.html#detached', active: true },
      { id: 1, url: 'https://web.whatsapp.com/', lastAccessed: 20 },
    ])
    await expect(resolveTabId(null)).resolves.toBe(1)
  })

  it('prefers the most recently looked-at page among several', async () => {
    const { resolveTabId } = loadResolver([
      { id: 9, url: 'chrome://extensions', active: true },
      { id: 1, url: 'https://amazon.in/', lastAccessed: 10 },
      { id: 2, url: 'https://web.whatsapp.com/', lastAccessed: 99 },
      { id: 3, url: 'https://google.com/', lastAccessed: 50 },
    ])
    await expect(resolveTabId(null)).resolves.toBe(2)
  })

  it('honours an explicitly requested tab without searching', async () => {
    const { resolveTabId } = loadResolver([])
    await expect(resolveTabId(7)).resolves.toBe(7)
  })

  it('only gives up when there is genuinely nowhere to work', async () => {
    const { resolveTabId } = loadResolver([
      { id: 9, url: 'chrome-extension://abc/index.html', active: true },
    ])
    await expect(resolveTabId(null)).rejects.toThrow(/no ordinary web page is open/)
  })

  it('names the unreadable page in the give-up message', async () => {
    const { resolveTabId } = loadResolver([
      { id: 9, url: 'chrome://extensions', active: true },
    ])
    await expect(resolveTabId(null)).rejects.toThrow(/chrome:/)
  })
})
