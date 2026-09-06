/*
 * agent-background.js -- MV3 service worker.
 *
 *  * Holds the WebSocket to the reasoning server (the "brain").
 *  * Keeps itself alive: Chrome extends a service worker's life while a
 *    WebSocket exchanges messages inside every 30s window, so we ping at 20s.
 *  * Executes browser-level verbs (tabs, navigation, screenshots) and forwards
 *    page-level verbs to the content script.
 *  * Escalates to chrome.debugger (CDP) only for JavaScript dialogs.
 *
 * No site-specific logic lives here.
 */

const DEFAULT_SERVER = 'ws://127.0.0.1:8787/ws/agent'
const KEEPALIVE_MS = 20000
const BACKOFF_MIN_MS = 1500
const BACKOFF_MAX_MS = 3000
const NAV_TIMEOUT_MS = 25000

let ws = null
let keepaliveTimer = null
let reconnectTimer = null
let sessionId = null
let connected = false

/** Tab the agent is currently driving, and tabs the agent itself opened. */
let currentTabId = null
const agentOwnedTabs = new Set()
const debuggerAttached = new Set()

// ---------------------------------------------------------------------------
// Session identity: a reconnect must look like the SAME session to the server.
// ---------------------------------------------------------------------------
async function getSessionId() {
  if (sessionId) return sessionId
  const stored = await chrome.storage.local.get('agentSessionId')
  if (stored.agentSessionId) {
    sessionId = stored.agentSessionId
  } else {
    sessionId = 'sess_' + Math.random().toString(16).slice(2, 10) + Date.now().toString(16)
    await chrome.storage.local.set({ agentSessionId: sessionId })
  }
  return sessionId
}

async function getServerUrl() {
  const stored = await chrome.storage.local.get('agentServerUrl')
  return stored.agentServerUrl || DEFAULT_SERVER
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
function envelope(type, payload, extra) {
  return Object.assign({
    v: 1,
    type: type,
    ts: new Date().toISOString(),
    task_id: null,
    step: 0,
    seq: 0,
    payload: payload || {},
  }, extra || {})
}

function send(type, payload, extra) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  ws.send(JSON.stringify(envelope(type, payload, extra)))
  return true
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  const sid = await getSessionId()
  const base = await getServerUrl()
  const url = base + '?session_id=' + encodeURIComponent(sid)

  try {
    ws = new WebSocket(url)
  } catch (e) {
    scheduleReconnect()
    return
  }

  ws.onopen = () => {
    connected = true
    console.log('[agent] WS connected ->', base)
    send('WS_CONNECTED', {
      session_id: sid,
      user_agent: navigator.userAgent,
      extension_version: chrome.runtime.getManifest().version,
    })
    startKeepalive()
    setBadge('ON', '#0f766e')
  }

  ws.onmessage = async (event) => {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch (e) {
      return
    }
    if (msg.type === 'PONG' || msg.type === 'PING') return
    if (msg.type === 'BRIDGE_REQUEST') {
      const { req_id } = msg.payload || {}
      let response
      try {
        response = await handleBridgeRequest(msg.payload)
      } catch (e) {
        response = { ok: false, error: String(e && e.message ? e.message : e) }
      }
      send('BRIDGE_RESPONSE', Object.assign({ req_id: req_id }, response), { task_id: msg.task_id || null })
    }
  }

  ws.onclose = () => {
    connected = false
    stopKeepalive()
    setBadge('', '#888888')
    scheduleReconnect()
  }

  ws.onerror = () => {
    // onclose always follows; reconnect is handled there.
  }
}

function startKeepalive() {
  stopKeepalive()
  // Chrome only keeps the SW alive while WS messages flow within each 30s
  // window. 20s gives comfortable margin.
  keepaliveTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      send('PING', { t: Date.now() })
    }
  }, KEEPALIVE_MS)
}

function stopKeepalive() {
  if (keepaliveTimer) clearInterval(keepaliveTimer)
  keepaliveTimer = null
}

function scheduleReconnect() {
  if (reconnectTimer) return
  const delay = BACKOFF_MIN_MS + Math.random() * (BACKOFF_MAX_MS - BACKOFF_MIN_MS)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
}

function setBadge(text, color) {
  try {
    chrome.action.setBadgeText({ text: text })
    chrome.action.setBadgeBackgroundColor({ color: color })
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Tab helpers
// ---------------------------------------------------------------------------
async function resolveTabId(requested) {
  if (requested) return requested
  if (currentTabId != null) {
    try {
      await chrome.tabs.get(currentTabId)
      return currentTabId
    } catch (e) {
      currentTabId = null
    }
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (active) {
    currentTabId = active.id
    return active.id
  }
  const any = await chrome.tabs.query({})
  const usable = any.find((t) => /^https?:/.test(t.url || ''))
  if (usable) {
    currentTabId = usable.id
    return usable.id
  }
  throw new Error('no usable tab available')
}

function isInjectable(url) {
  return /^https?:\/\//.test(url || '')
}

async function ensureContentScript(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'AGENT_PING' })
    if (r && r.ok) return true
  } catch (e) { /* not injected yet */ }
  const tab = await chrome.tabs.get(tabId)
  if (!isInjectable(tab.url)) {
    throw new Error('cannot operate on this page (' + (tab.url || 'unknown') + '); chrome:// and store pages block extensions')
  }
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    files: ['agent-content.js'],
  })
  await new Promise((r) => setTimeout(r, 250))
  return true
}

async function callContent(tabId, message) {
  await ensureContentScript(tabId)
  return chrome.tabs.sendMessage(tabId, message)
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const finish = (status) => {
      if (done) return
      done = true
      chrome.tabs.onUpdated.removeListener(listener)
      clearTimeout(timer)
      resolve(status)
    }
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish('complete')
    }
    chrome.tabs.onUpdated.addListener(listener)
    const timer = setTimeout(() => finish('timeout'), timeoutMs || NAV_TIMEOUT_MS)
    chrome.tabs.get(tabId).then((t) => {
      if (t && t.status === 'complete') finish('already-complete')
    }).catch(() => finish('gone'))
  })
}

async function listTabs() {
  const tabs = await chrome.tabs.query({})
  return tabs
    .filter((t) => isInjectable(t.url))
    .slice(0, 30)
    .map((t) => ({
      tab_id: t.id,
      url: (t.url || '').slice(0, 300),
      title: (t.title || '').slice(0, 120),
      active: !!t.active,
      agent_owned: agentOwnedTabs.has(t.id),
    }))
}

// ---------------------------------------------------------------------------
// Screenshots: capture -> mask sensitive boxes -> jpeg base64.
// The canvas is used ONLY to black out regions; nothing is ever drawn.
// ---------------------------------------------------------------------------
async function captureRedacted(tabId, sensitiveBoxes) {
  const tab = await chrome.tabs.get(tabId)
  let dataUrl
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 })
  } catch (e) {
    return { ok: false, error: 'captureVisibleTab failed: ' + e.message }
  }
  try {
    const blob = await (await fetch(dataUrl)).blob()
    const bmp = await createImageBitmap(blob)
    const canvas = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bmp, 0, 0)
    ctx.fillStyle = '#000000'
    for (const b of sensitiveBoxes || []) {
      if (!Array.isArray(b) || b.length < 4) continue
      ctx.fillRect(b[0], b[1], b[2], b[3])
    }
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 })
    const buf = await out.arrayBuffer()
    const bytes = new Uint8Array(buf)
    let binary = ''
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
    }
    return { ok: true, screenshot: btoa(binary), masked_regions: (sensitiveBoxes || []).length, w: bmp.width, h: bmp.height }
  } catch (e) {
    return { ok: false, error: 'redaction failed: ' + e.message }
  }
}

// ---------------------------------------------------------------------------
// chrome.debugger escalation -- JavaScript dialogs only.
// ---------------------------------------------------------------------------
async function handleJsDialog(tabId, accept) {
  const target = { tabId: tabId }
  try {
    if (!debuggerAttached.has(tabId)) {
      await chrome.debugger.attach(target, '1.3')
      debuggerAttached.add(tabId)
      await chrome.debugger.sendCommand(target, 'Page.enable')
    }
    await chrome.debugger.sendCommand(target, 'Page.handleJavaScriptDialog', { accept: accept !== false })
    return { ok: true, result: { dialog_handled: true, accepted: accept !== false } }
  } catch (e) {
    return { ok: false, error: 'debugger dialog handling failed: ' + e.message }
  }
}

chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId != null) debuggerAttached.delete(source.tabId)
})

// ---------------------------------------------------------------------------
// BRIDGE REQUEST DISPATCH
// ---------------------------------------------------------------------------
const PAGE_VERBS = ['click', 'type', 'keypress', 'scroll', 'hover', 'focus', 'select', 'wait', 'extract', 'submit', 'dismiss_overlay']

async function handleBridgeRequest(payload) {
  const op = payload.op
  const args = payload.args || {}

  switch (op) {
    case 'ping':
      return { ok: true, result: { pong: true, current_tab: currentTabId } }

    case 'tabs':
      return { ok: true, result: { tabs: await listTabs(), active_tab_id: await resolveTabId(null) } }

    case 'observe': {
      const tabId = await resolveTabId(args.tab_id)
      const r = await callContent(tabId, { type: 'AGENT_OBSERVE' })
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'observe failed' }
      const obs = r.observation
      obs.tabs = await listTabs()
      obs.active_tab_id = tabId
      if (args.screenshot) {
        const shot = await captureRedacted(tabId, obs.sensitive_boxes)
        obs.screenshot = shot.ok ? shot.screenshot : null
        obs.screenshot_error = shot.ok ? null : shot.error
      }
      return { ok: true, result: obs }
    }

    case 'screenshot': {
      const tabId = await resolveTabId(args.tab_id)
      let boxes = args.sensitive_boxes
      if (!boxes) {
        try {
          const r = await callContent(tabId, { type: 'AGENT_OBSERVE' })
          boxes = r && r.ok ? r.observation.sensitive_boxes : []
        } catch (e) {
          boxes = []
        }
      }
      const shot = await captureRedacted(tabId, boxes)
      return shot.ok ? { ok: true, result: shot } : { ok: false, error: shot.error }
    }

    case 'navigate': {
      const tabId = await resolveTabId(args.tab_id)
      const url = args.url
      if (!url) return { ok: false, error: 'navigate requires params.url' }
      const before = (await chrome.tabs.get(tabId)).url
      await chrome.tabs.update(tabId, { url: url })
      const status = await waitForTabComplete(tabId, NAV_TIMEOUT_MS)
      const after = (await chrome.tabs.get(tabId)).url
      return { ok: true, result: { from: before, to: after, load: status, tab_id: tabId } }
    }

    case 'open_tab': {
      const tab = await chrome.tabs.create({ url: args.url || 'about:blank', active: true })
      agentOwnedTabs.add(tab.id)
      currentTabId = tab.id
      const status = await waitForTabComplete(tab.id, NAV_TIMEOUT_MS)
      const fresh = await chrome.tabs.get(tab.id)
      return { ok: true, result: { tab_id: tab.id, url: fresh.url, load: status, agent_owned: true } }
    }

    case 'switch_tab': {
      const tabId = args.tab_id
      if (tabId == null) return { ok: false, error: 'switch_tab requires target.tab_id' }
      const tab = await chrome.tabs.get(tabId)
      await chrome.tabs.update(tabId, { active: true })
      await chrome.windows.update(tab.windowId, { focused: true })
      currentTabId = tabId
      return { ok: true, result: { tab_id: tabId, url: tab.url } }
    }

    case 'close_tab': {
      const tabId = args.tab_id
      if (tabId == null) return { ok: false, error: 'close_tab requires target.tab_id' }
      if (!agentOwnedTabs.has(tabId)) {
        return { ok: false, error: 'refusing to close a tab the agent did not open (tab ' + tabId + ')' }
      }
      await chrome.tabs.remove(tabId)
      agentOwnedTabs.delete(tabId)
      if (currentTabId === tabId) currentTabId = null
      return { ok: true, result: { closed: tabId } }
    }

    case 'back':
    case 'forward': {
      const tabId = await resolveTabId(args.tab_id)
      const before = (await chrome.tabs.get(tabId)).url
      if (op === 'back') await chrome.tabs.goBack(tabId)
      else await chrome.tabs.goForward(tabId)
      await waitForTabComplete(tabId, 8000)
      const after = (await chrome.tabs.get(tabId)).url
      return { ok: true, result: { from: before, to: after } }
    }

    case 'handle_dialog': {
      const tabId = await resolveTabId(args.tab_id)
      return handleJsDialog(tabId, args.accept)
    }

    case 'reload': {
      const tabId = await resolveTabId(args.tab_id)
      await chrome.tabs.reload(tabId)
      const status = await waitForTabComplete(tabId, NAV_TIMEOUT_MS)
      return { ok: true, result: { reloaded: true, load: status } }
    }

    case 'act': {
      const action = args.action || {}
      const verb = action.action
      if (PAGE_VERBS.indexOf(verb) === -1) {
        return { ok: false, error: 'not a page verb: ' + verb }
      }
      const tabId = await resolveTabId(action.target && action.target.tab_id)
      const r = await callContent(tabId, { type: 'AGENT_EXECUTE', action: action })
      if (!r) return { ok: false, error: 'no response from content script' }
      // A click may start a navigation; give it a moment to settle.
      if (verb === 'click' || verb === 'submit' || verb === 'keypress') {
        await Promise.race([
          waitForTabComplete(tabId, 4000),
          new Promise((res) => setTimeout(res, 1200)),
        ])
      }
      return r
    }

    default:
      return { ok: false, error: 'unknown bridge op: ' + op }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => { connect() })
chrome.runtime.onStartup.addListener(() => { connect() })
chrome.tabs.onRemoved.addListener((tabId) => {
  agentOwnedTabs.delete(tabId)
  debuggerAttached.delete(tabId)
  if (currentTabId === tabId) currentTabId = null
})

// Popup / options can ask for status or point us at a different server.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return false
  if (message.type === 'AGENT_STATUS') {
    getSessionId().then((sid) => {
      sendResponse({ connected: connected, session_id: sid, current_tab: currentTabId })
    })
    return true
  }
  if (message.type === 'AGENT_SET_SERVER') {
    chrome.storage.local.set({ agentServerUrl: message.url }).then(() => {
      if (ws) try { ws.close() } catch (e) { /* ignore */ }
      connect()
      sendResponse({ ok: true })
    })
    return true
  }
  if (message.type === 'AGENT_RECONNECT') {
    if (ws) try { ws.close() } catch (e) { /* ignore */ }
    connect()
    sendResponse({ ok: true })
    return true
  }
  return false
})

connect()
console.log('[agent] service worker booted')
