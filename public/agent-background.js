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
// Slow sites are common; a navigation that takes 40s is slow, not broken.
const NAV_TIMEOUT_MS = 60000

let ws = null
let keepaliveTimer = null
let reconnectTimer = null
let sessionId = null
let connected = false

/** Tab the agent is currently driving, and tabs the agent itself opened. */
let currentTabId = null
// Ordered newest-first: after a service-worker restart the agent must resume in
// the tab it was most recently driving, not the oldest one it ever opened.
const agentOwnedTabs = new Set()
async function rememberCurrentTab(tabId) {
  currentTabId = tabId
  try { await chrome.storage.session.set({ agentCurrentTab: tabId }) } catch (e) { /* ignore */ }
}
async function recallCurrentTab() {
  if (currentTabId != null) return currentTabId
  try {
    const v = await chrome.storage.session.get('agentCurrentTab')
    if (v && v.agentCurrentTab != null) currentTabId = v.agentCurrentTab
  } catch (e) { /* ignore */ }
  return currentTabId
}
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
  await recallCurrentTab()

  // 1. The tab this task has been working in, if it still exists and is usable.
  if (currentTabId != null) {
    try {
      const tab = await chrome.tabs.get(currentTabId)
      if (isInjectable(tab.url)) return currentTabId
    } catch (e) { /* the tab is gone */ }
    currentTabId = null
  }

  // 2. A tab the agent opened itself -- most recent first.
  for (const id of Array.from(agentOwnedTabs).reverse()) {
    try {
      const tab = await chrome.tabs.get(id)
      if (isInjectable(tab.url)) {
        await rememberCurrentTab(id)
        return id
      }
    } catch (e) {
      agentOwnedTabs.delete(id)
    }
  }

  // 3. The user's active tab -- but ONLY if an extension can actually run
  // there. chrome://, the Web Store and PDF viewers are closed to us, and
  // silently adopting one of those makes every later step fail for a reason
  // that has nothing to do with the task.
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (active && isInjectable(active.url)) {
    currentTabId = active.id
    return active.id
  }

  // 4. Any other ordinary web page.
  const any = await chrome.tabs.query({})
  const usable = any.find((t) => isInjectable(t.url))
  if (usable) {
    currentTabId = usable.id
    return usable.id
  }

  throw new Error(
    'no ordinary web page is open for the agent to work in' +
    (active && active.url ? ' (the active tab is ' + active.url.split('/')[0] + '//..., which blocks extensions)' : '') +
    '. Open any http(s) page and try again.'
  )
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

async function attachDebugger(tabId) {
  if (debuggerAttached.has(tabId)) return
  await chrome.debugger.attach({ tabId: tabId }, '1.3')
  debuggerAttached.add(tabId)
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function waitForDownload(id, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const finish = (item) => {
      if (done) return
      done = true
      chrome.downloads.onChanged.removeListener(listener)
      clearTimeout(timer)
      resolve(item)
    }
    const check = async () => {
      const [item] = await chrome.downloads.search({ id: id })
      if (item && (item.state === 'complete' || item.state === 'interrupted')) finish(item)
    }
    const listener = (delta) => { if (delta.id === id) check() }
    chrome.downloads.onChanged.addListener(listener)
    const timer = setTimeout(() => finish({ state: 'timeout' }), timeoutMs || 120000)
    check()
  })
}

async function uploadFile(tabId, eid, filePath) {
  const target = { tabId: tabId }
  try {
    await attachDebugger(tabId)
    await chrome.debugger.sendCommand(target, 'DOM.enable')
    await chrome.debugger.sendCommand(target, 'Runtime.enable')

    // Resolve the element the agent chose into a CDP object handle.
    const evaled = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: 'document.querySelector(\'[data-agent-eid="' + eid + '"]\')',
      returnByValue: false,
    })
    const objectId = evaled && evaled.result && evaled.result.objectId
    if (!objectId) {
      return { ok: false, error: 'stale_element', detail: 'no element with eid ' + eid }
    }
    const node = await chrome.debugger.sendCommand(target, 'DOM.requestNode', { objectId: objectId })
    if (!node || !node.nodeId) {
      return { ok: false, error: 'could not resolve the element into a DOM node' }
    }

    await chrome.debugger.sendCommand(target, 'DOM.setFileInputFiles', {
      nodeId: node.nodeId,
      files: [filePath],
    })

    // Read back what the input now holds -- the honest confirmation.
    const readback = await chrome.debugger.sendCommand(target, 'Runtime.callFunctionOn', {
      objectId: objectId,
      functionDeclaration:
        'function(){ return this.files ? Array.from(this.files).map(f=>f.name+" ("+f.size+" bytes)").join(", ") : "not a file input" }',
      returnByValue: true,
    })
    const attached = readback && readback.result ? readback.result.value : ''
    return {
      ok: !!attached && attached !== 'not a file input',
      result: { attached_files: attached, path: filePath, via: 'CDP DOM.setFileInputFiles' },
      error: attached && attached !== 'not a file input' ? undefined
        : 'the element did not accept the file (is it an <input type="file">?)',
    }
  } catch (e) {
    return { ok: false, error: 'upload failed: ' + String((e && e.message) || e) }
  }
}

// ---------------------------------------------------------------------------
// BRIDGE REQUEST DISPATCH
// ---------------------------------------------------------------------------
const PAGE_VERBS = ['click', 'type', 'keypress', 'scroll', 'hover', 'focus', 'select', 'wait', 'extract', 'submit', 'dismiss_overlay']

// Verbs whose whole point may be to leave the current page.
const CAN_NAVIGATE = ['click', 'submit', 'keypress']

// Ways Chrome reports "the document you were talking to is gone", all of which
// a navigation can cause the instant after the action was genuinely performed.
const NAVIGATION_RACE = /back\/forward cache|message channel is closed|message port closed|Receiving end does not exist|Extension context invalidated|The tab was closed|No tab with id/i

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
      await rememberCurrentTab(tab.id)
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
      await rememberCurrentTab(tabId)
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

    case 'download': {
      const url = args.url
      if (!url) return { ok: false, error: 'download requires params.url' }
      const id = await chrome.downloads.download({ url: url })
      const done = await waitForDownload(id, 120000)
      return done.state === 'complete'
        ? { ok: true, result: { download_id: id, path: done.filename, bytes: done.fileSize, url: url } }
        : { ok: false, error: 'download did not complete: ' + (done.error || done.state) }
    }

    case 'list_downloads': {
      const query = { orderBy: ['-startTime'], limit: 20, state: 'complete' }
      if (args.filename_contains) query.filenameRegex = escapeRegex(args.filename_contains)
      const items = await chrome.downloads.search(query)
      return {
        ok: true,
        result: {
          downloads: items.map((d) => ({
            id: d.id, path: d.filename, bytes: d.fileSize,
            mime: d.mime, finished: d.endTime, source: (d.url || '').slice(0, 160),
          })),
        },
      }
    }

    case 'upload_file': {
      // A file input cannot be populated from page script -- the browser will
      // not let untrusted code hand a site a file off the user's disk. The
      // legitimate route is CDP's DOM.setFileInputFiles, which is exactly what
      // a human picking the file in the dialog would produce.
      const tabId = await resolveTabId(args.tab_id)
      const eid = args.element_id
      const filePath = args.file_path
      if (!eid) return { ok: false, error: 'upload_file requires target.element_id (the file input)' }
      if (!filePath) return { ok: false, error: 'upload_file requires params.file_path' }
      return uploadFile(tabId, eid, filePath)
    }

    case 'act': {
      const action = args.action || {}
      const verb = action.action
      if (PAGE_VERBS.indexOf(verb) === -1) {
        return { ok: false, error: 'not a page verb: ' + verb }
      }
      const tabId = await resolveTabId(action.target && action.target.tab_id)

      let r
      try {
        r = await callContent(tabId, { type: 'AGENT_EXECUTE', action: action })
      } catch (e) {
        const msg = String((e && e.message) || e)
        // A successful click is often indistinguishable from a failed one at
        // this layer: the click starts a navigation, Chrome tears the old
        // document down (or parks it in the back/forward cache), and the reply
        // never arrives. Reporting that as a failure makes the agent retry an
        // action it already performed -- which is how you get an agent
        // bouncing between two pages forever.
        //
        // So for verbs that can navigate, say honestly that the action went out
        // and the outcome is unknown. The verifier settles it from the next
        // real observation, which is the only trustworthy source anyway.
        if (NAVIGATION_RACE.test(msg) && CAN_NAVIGATE.indexOf(verb) !== -1) {
          await Promise.race([
            waitForTabComplete(tabId, 6000),
            new Promise((res) => setTimeout(res, 1500)),
          ])
          let landedOn = ''
          try { landedOn = (await chrome.tabs.get(tabId)).url } catch (e2) { /* gone */ }
          return {
            ok: true,
            result: {
              dispatched: true,
              outcome: 'unknown-navigation-raced-the-reply',
              detail: 'the page navigated before the content script could answer',
              landed_on: landedOn,
              channel_error: msg,
            },
          }
        }
        throw e
      }

      if (!r) return { ok: false, error: 'no response from content script' }
      // A click may start a navigation; give it a moment to settle.
      if (CAN_NAVIGATE.indexOf(verb) !== -1) {
        // Resolve as soon as the load finishes; only fall back to a short
        // fixed wait when the click started no navigation at all.
        await Promise.race([
          waitForTabComplete(tabId, 4000),
          new Promise((res) => setTimeout(res, 450)),
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
