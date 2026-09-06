/*
 * agent-content.js -- perception + execution surface running in the page.
 *
 * Responsibilities:
 *   1. PERCEPTION : walk the DOM, assign stable element identity, emit the
 *                   Observation contract.
 *   2. REDACTION  : strip PII out of every name/text/value before it can leave
 *                   the page, and report sensitive boxes for screenshot masking.
 *   3. EXECUTION  : perform page-level verbs (click/type/keypress/scroll/...).
 *
 * This file contains NO site-specific logic. Every branch is on structure,
 * roles and generic signals -- never on a hostname.
 */

const AGENT_EID = 'agentEid'
const AGENT_NID = 'agentNid'
const MAX_ELEMENTS = 220
const TEXT_CAP = 160

// ---------------------------------------------------------------------------
// PII patterns (harvested from the legacy on-device scanner).
// NOTE: `currency` is deliberately NOT a redaction pattern -- prices are task
// data the agent must be able to read. It is used only for price detection.
// ---------------------------------------------------------------------------
const PII_PATTERNS = [
  { type: 'CARD', regex: /\b(?:\d[ -]*?){13,19}\b/g },
  { type: 'AADHAAR', regex: /\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b(?!\s?\d)/g },
  { type: 'PAN', regex: /\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/g },
  { type: 'GSTIN', regex: /\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}\b/g },
  { type: 'VOTERID', regex: /\b[A-Z]{3}[0-9]{7}\b/g },
  { type: 'DL', regex: /\b[A-Z]{2}[0-9]{2}[ -]?(?:19|20)[0-9]{2}[0-9]{7}\b/g },
  { type: 'UPI', regex: /\b[\w.-]+@(?:upi|oksbi|okhdfcbank|okaxis|paytm|ibl|ybl|apl)\b/gi },
  { type: 'EMAIL', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { type: 'PHONE', regex: /\b(?:\+91[\s-]?)?[6-9]\d{9}\b/g },
]

const PRICE_REGEX = /(?:₹|Rs\.?|INR|\$|€|£)\s?[\d,]+(?:\.\d{1,2})?/i

// Field names whose *values* must never leave the page at all.
const PROTECTED_FIELD_REGEX = /password|passwd|\botp\b|cvv|cvc|card\s*number|cardnumber|aadhaar|upi\s*pin|\bpin\b|secret|token/i

let redactionCounts = {}

function redact(text) {
  if (!text) return ''
  let out = String(text).replace(/\s+/g, ' ').trim()
  for (const p of PII_PATTERNS) {
    p.regex.lastIndex = 0
    out = out.replace(p.regex, () => {
      redactionCounts[p.type] = (redactionCounts[p.type] || 0) + 1
      return '[REDACTED:' + p.type + ']'
    })
  }
  return out
}

function hasPii(text) {
  if (!text) return false
  return PII_PATTERNS.some((p) => {
    p.regex.lastIndex = 0
    return p.regex.test(text)
  })
}

// ---------------------------------------------------------------------------
// Element identity
// ---------------------------------------------------------------------------
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

function computeNid(el, rect, name) {
  const sig = [
    el.tagName.toLowerCase(),
    el.id || '',
    el.getAttribute('aria-label') || '',
    (name || '').slice(0, 32),
    Math.round(rect.width) + 'x' + Math.round(rect.height),
  ].join('|')
  return fnv1a(sig)
}

function cssPath(el) {
  const parts = []
  let node = el
  let depth = 0
  while (node && node.nodeType === 1 && depth < 8) {
    let part = node.tagName.toLowerCase()
    if (node.id) {
      parts.unshift(part + '#' + CSS.escape(node.id))
      break
    }
    const parent = node.parentElement
    if (parent) {
      const sibs = Array.from(parent.children).filter((s) => s.tagName === node.tagName)
      if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')'
    }
    parts.unshift(part)
    node = node.parentElement
    depth += 1
  }
  return parts.join(' > ')
}

// ---------------------------------------------------------------------------
// Roles / names / visibility
// ---------------------------------------------------------------------------
function roleOf(el) {
  const explicit = el.getAttribute('role')
  if (explicit) return explicit
  const tag = el.tagName.toLowerCase()
  if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic'
  if (tag === 'button') return 'button'
  if (tag === 'select') return 'combobox'
  if (tag === 'textarea') return 'textbox'
  if (tag === 'summary') return 'button'
  if (tag === 'input') {
    const t = (el.getAttribute('type') || 'text').toLowerCase()
    if (t === 'checkbox') return 'checkbox'
    if (t === 'radio') return 'radio'
    if (t === 'submit' || t === 'button' || t === 'reset') return 'button'
    return 'textbox'
  }
  if (el.isContentEditable) return 'textbox'
  return tag
}

function labelText(el) {
  if (el.id) {
    const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]')
    if (lab && lab.textContent) return lab.textContent
  }
  const wrapping = el.closest ? el.closest('label') : null
  if (wrapping && wrapping.textContent) return wrapping.textContent
  return ''
}

function accessibleName(el) {
  const aria = el.getAttribute('aria-label')
  if (aria) return aria
  const labelledby = el.getAttribute('aria-labelledby')
  if (labelledby) {
    const txt = labelledby
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((n) => n.textContent || '')
      .join(' ')
    if (txt.trim()) return txt
  }
  const lab = labelText(el)
  if (lab.trim()) return lab
  const candidates = [
    el.getAttribute('placeholder'),
    el.getAttribute('title'),
    el.getAttribute('alt'),
    el.getAttribute('name'),
  ]
  const attr = candidates.find((c) => c && c.trim())
  if (attr) return attr
  const inner = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
  if (inner) return inner
  const img = el.querySelector ? el.querySelector('img[alt]') : null
  if (img) return img.getAttribute('alt') || ''
  return ''
}

function isVisible(el, rect, style) {
  if (!rect) rect = el.getBoundingClientRect()
  if (!style) style = window.getComputedStyle(el)
  if (rect.width <= 1 || rect.height <= 1) return false
  if (style.display === 'none' || style.visibility === 'hidden') return false
  if (Number(style.opacity) === 0) return false
  return true
}

function isEditable(el) {
  const tag = el.tagName.toLowerCase()
  if (tag === 'textarea') return true
  if (tag === 'select') return true
  if (tag === 'input') {
    const t = (el.getAttribute('type') || 'text').toLowerCase()
    return ['submit', 'button', 'reset', 'image', 'hidden'].indexOf(t) === -1
  }
  return el.isContentEditable === true
}

function isProtectedField(el) {
  const t = (el.getAttribute('type') || '').toLowerCase()
  if (t === 'password') return true
  const hay = [
    el.getAttribute('name'),
    el.getAttribute('id'),
    el.getAttribute('aria-label'),
    el.getAttribute('placeholder'),
    el.getAttribute('autocomplete'),
    labelText(el),
  ]
    .filter(Boolean)
    .join(' ')
  return PROTECTED_FIELD_REGEX.test(hay)
}

// ---------------------------------------------------------------------------
// Page-state signals (all generic -- no hostnames anywhere)
// ---------------------------------------------------------------------------
function appNameFromHost() {
  // Generic: take the most significant label of the hostname, dropping public
  // suffixes and common subdomain prefixes. A chat host resolves to its brand
  // label and a mail host to its provider label, with no domain literal here.
  const parts = location.hostname.split('.').filter((p) => p && p !== 'www')
  if (parts.length === 0) return 'generic'
  const generic = ['com', 'net', 'org', 'co', 'in', 'io', 'app', 'web', 'mail', 'accounts']
  const meaningful = parts.filter((p) => generic.indexOf(p) === -1)
  return (meaningful[meaningful.length - 1] || parts[0]).toLowerCase()
}

function detectLoginWall() {
  const bodyText = (document.body ? document.body.innerText || '' : '').slice(0, 6000)

  // Signal 1: a large canvas plus scan/QR wording, with no populated list of
  // conversations/threads behind it => device-linking QR wall.
  const canvases = Array.from(document.querySelectorAll('canvas')).filter((c) => {
    const r = c.getBoundingClientRect()
    return r.width * r.height > 20000
  })
  const scanWording = /\b(scan (the |this )?qr|qr code|link (a |your )?device|log in(to)? .{0,20} by scanning)\b/i.test(bodyText)
  const populatedList = document.querySelectorAll('[role="listitem"], [role="row"], [role="gridcell"]').length > 3
  if (canvases.length > 0 && scanWording && !populatedList) {
    return { app: appNameFromHost(), kind: 'qr', hint: 'Scan the QR code with your phone to sign in.' }
  }

  // Signal 2: a visible password field, or a sign-in URL shape with an
  // identifier field => credential wall.
  const pwd = Array.from(document.querySelectorAll('input[type="password"]')).find((el) => isVisible(el))
  const signinUrl = /(^|\/)(signin|sign-in|sign_in|login|log-in|auth|oauth|challenge)(\/|\?|$)/i.test(location.pathname + location.search)
  const identifier = document.querySelector('input[type="email"], input[name*="identifier" i], input[name*="email" i], input[autocomplete="username"]')
  if (pwd || (signinUrl && identifier)) {
    return { app: appNameFromHost(), kind: 'credential', hint: 'Sign in with your account to continue.' }
  }
  return null
}

function detectOverlay() {
  const nodes = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]'))
  for (const n of nodes) {
    const r = n.getBoundingClientRect()
    if (isVisible(n, r) && r.width * r.height > 10000) return true
  }
  // Generic modal/backdrop heuristic: a fixed, high-z-index, large element.
  const all = Array.from(document.body ? document.body.children : [])
  for (const n of all) {
    let st
    try {
      st = window.getComputedStyle(n)
    } catch (e) {
      continue
    }
    if (st.position !== 'fixed') continue
    const r = n.getBoundingClientRect()
    const z = Number(st.zIndex) || 0
    if (z >= 1000 && r.width > window.innerWidth * 0.5 && r.height > window.innerHeight * 0.4 && isVisible(n, r, st)) {
      return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// THE WALKER
// ---------------------------------------------------------------------------
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  'summary',
  '[role]',
  '[contenteditable="true"]',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const KEEP_ROLES = [
  'button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'tab', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'option', 'switch', 'searchbox', 'slider',
  'listitem', 'row', 'gridcell', 'treeitem', 'dialog', 'alertdialog',
]

function walk() {
  redactionCounts = {}
  const started = performance.now()
  const errors = []
  const sensitiveBoxes = []
  const dpr = window.devicePixelRatio || 1

  // Clear last observation's ephemeral ids.
  document.querySelectorAll('[data-agent-eid]').forEach((n) => {
    delete n.dataset[AGENT_EID]
  })

  let raw = []
  try {
    raw = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR))
  } catch (e) {
    errors.push('selector: ' + e.message)
  }

  const seen = new Set()
  const elements = []
  let n = 0

  for (const el of raw) {
    if (elements.length >= MAX_ELEMENTS) break
    if (seen.has(el)) continue
    seen.add(el)

    let rect
    let style
    try {
      rect = el.getBoundingClientRect()
      style = window.getComputedStyle(el)
    } catch (e) {
      continue
    }
    if (!isVisible(el, rect, style)) continue

    const role = roleOf(el)
    const tag = el.tagName.toLowerCase()
    const editable = isEditable(el)
    const isNative = ['a', 'button', 'input', 'textarea', 'select', 'summary'].indexOf(tag) !== -1
    if (!isNative && !editable && KEEP_ROLES.indexOf(role) === -1) continue

    const rawName = accessibleName(el)
    const rawText = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()

    // Never let a protected field's value out of the page.
    const protectedField = isProtectedField(el)
    let value = ''
    if (editable) {
      const v = el.value !== undefined && el.value !== null ? el.value : (el.textContent || '')
      if (protectedField) {
        value = v ? '[PROTECTED INPUT] len=' + String(v).length : ''
      } else {
        value = redact(String(v).slice(0, TEXT_CAP))
      }
    }

    const eid = 'e' + n
    n += 1
    el.dataset[AGENT_EID] = eid
    const nid = computeNid(el, rect, rawName)
    el.dataset[AGENT_NID] = nid

    const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth

    if (protectedField || hasPii(rawName) || hasPii(rawText)) {
      sensitiveBoxes.push([
        Math.round(rect.left * dpr), Math.round(rect.top * dpr),
        Math.round(rect.width * dpr), Math.round(rect.height * dpr),
      ])
    }

    elements.push({
      eid: eid,
      nid: nid,
      role: role,
      name: redact(rawName).slice(0, TEXT_CAP),
      text: redact(rawText).slice(0, TEXT_CAP),
      tag: tag,
      box: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
      in_viewport: inViewport,
      is_editable: editable,
      input_type: el.getAttribute('type') || '',
      href: tag === 'a' ? (el.getAttribute('href') || '').slice(0, 300) : '',
      value: value,
      is_protected: protectedField,
      path: cssPath(el),
    })
  }

  // Also record PII found in plain page text so screenshots mask it.
  try {
    const blocks = Array.from(document.querySelectorAll('p, span, td, th, li, label, h1, h2, h3, div'))
      .filter((b) => b.children.length <= 2)
      .slice(0, 400)
    for (const b of blocks) {
      const t = (b.innerText || '').trim()
      if (!t || t.length > 240) continue
      if (!hasPii(t)) continue
      const r = b.getBoundingClientRect()
      if (!isVisible(b, r)) continue
      sensitiveBoxes.push([
        Math.round(r.left * dpr), Math.round(r.top * dpr),
        Math.round(r.width * dpr), Math.round(r.height * dpr),
      ])
    }
  } catch (e) {
    errors.push('pii-scan: ' + e.message)
  }

  const focused = document.activeElement
  const focusedInfo = focused && focused !== document.body
    ? {
        eid: focused.dataset ? focused.dataset[AGENT_EID] || null : null,
        tag: focused.tagName ? focused.tagName.toLowerCase() : null,
        name: redact(accessibleName(focused)).slice(0, 80),
      }
    : null

  const forms = Array.from(document.querySelectorAll('form')).slice(0, 12).map((f, i) => ({
    index: i,
    name: redact(f.getAttribute('name') || f.getAttribute('id') || '').slice(0, 60),
    field_count: f.querySelectorAll('input, textarea, select').length,
  }))

  return {
    url: location.href,
    title: redact(document.title || location.hostname).slice(0, 160),
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: dpr },
    scroll: {
      x: Math.round(window.scrollX),
      y: Math.round(window.scrollY),
      max_y: Math.max(0, Math.round((document.documentElement.scrollHeight || 0) - window.innerHeight)),
    },
    page_state: {
      loading: document.readyState !== 'complete',
      overlay_present: detectOverlay(),
      login_wall: detectLoginWall(),
    },
    interactive_elements: elements,
    dom_summary: {
      element_count: document.querySelectorAll('*').length,
      interactive_count: elements.length,
      forms: forms,
    },
    focused_element: focusedInfo,
    screenshot: null,
    sensitive_boxes: sensitiveBoxes.slice(0, 200),
    errors: errors,
    pii_redactions: Object.assign({}, redactionCounts),
    walk_ms: Math.round(performance.now() - started),
    observed_at: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// ELEMENT RESOLUTION
// Order: eid (current observation) -> nid re-walk -> text signature -> css path.
// A miss is reported honestly as stale_element; the loop re-observes.
// ---------------------------------------------------------------------------
function resolve(target) {
  if (!target) return { el: null, how: 'no-target' }
  const eid = target.element_id
  if (eid) {
    const byEid = document.querySelector('[data-agent-eid="' + CSS.escape(eid) + '"]')
    if (byEid && isVisible(byEid)) return { el: byEid, how: 'eid' }
  }
  if (target.nid) {
    const byNid = document.querySelector('[data-agent-nid="' + CSS.escape(target.nid) + '"]')
    if (byNid && isVisible(byNid)) return { el: byNid, how: 'nid' }
  }
  if (target.name) {
    const needle = String(target.name).toLowerCase().slice(0, 40)
    const all = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR))
    const hit = all.find((el) => {
      if (!isVisible(el)) return false
      const nm = accessibleName(el).toLowerCase()
      return nm && (nm === needle || nm.indexOf(needle) === 0)
    })
    if (hit) return { el: hit, how: 'text-signature' }
  }
  if (target.path) {
    try {
      const byPath = document.querySelector(target.path)
      if (byPath && isVisible(byPath)) return { el: byPath, how: 'css-path' }
    } catch (e) { /* invalid path */ }
  }
  return { el: null, how: 'stale_element' }
}

// ---------------------------------------------------------------------------
// EXECUTION PRIMITIVES
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function scrollIntoView(el) {
  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  } catch (e) {
    el.scrollIntoView(true)
  }
  await sleep(120)
}

function centerOf(el) {
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
}

function fireMouse(el, type, pt) {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: pt.x,
    clientY: pt.y,
    button: 0,
    buttons: type === 'mousedown' || type === 'pointerdown' ? 1 : 0,
  })
  el.dispatchEvent(ev)
}

function firePointer(el, type, pt) {
  if (typeof PointerEvent !== 'function') return
  const ev = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: pt.x,
    clientY: pt.y,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    buttons: type === 'pointerdown' ? 1 : 0,
  })
  el.dispatchEvent(ev)
}

async function doClick(el) {
  await scrollIntoView(el)
  const pt = centerOf(el)
  // Report occlusion honestly rather than clicking a covering overlay.
  let occludedBy = null
  try {
    const top = document.elementFromPoint(pt.x, pt.y)
    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
      occludedBy = redact(accessibleName(top)).slice(0, 60) || top.tagName.toLowerCase()
    }
  } catch (e) { /* ignore */ }

  try { el.focus({ preventScroll: true }) } catch (e) { /* ignore */ }
  firePointer(el, 'pointerdown', pt)
  fireMouse(el, 'mousedown', pt)
  firePointer(el, 'pointerup', pt)
  fireMouse(el, 'mouseup', pt)
  fireMouse(el, 'click', pt)
  return { clicked: true, occluded_by: occludedBy, point: pt }
}

function nativeSetValue(el, text) {
  const proto = el.tagName.toLowerCase() === 'textarea'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')
  if (setter && setter.set) setter.set.call(el, text)
  else el.value = text
}

function normalizeForCompare(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

/*
 * Typing. Two very different DOM worlds:
 *  - <input>/<textarea>: native value setter + input/change events so React's
 *    value tracker sees the change.
 *  - contenteditable (chat composers, rich mail bodies): `.value=` does
 *    nothing. Focus, collapse the selection to the end, then use
 *    execCommand('insertText') which produces the real beforeinput/input
 *    events these editors listen for. Fallback to an InputEvent.
 * Either way we read the field back and report what actually landed.
 */
async function doType(el, text, replace) {
  await scrollIntoView(el)
  try { el.focus({ preventScroll: true }) } catch (e) { /* ignore */ }
  await sleep(60)

  const tag = el.tagName.toLowerCase()
  const isNativeField = tag === 'input' || tag === 'textarea'

  if (isNativeField) {
    if (replace !== false) {
      nativeSetValue(el, '')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    nativeSetValue(el, replace === false ? (el.value || '') + text : text)
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    const got = normalizeForCompare(el.value)
    return {
      typed: true,
      strategy: 'native-value-setter',
      verified: got.indexOf(normalizeForCompare(text)) !== -1,
      readback: redact(got).slice(0, 200),
    }
  }

  if (el.isContentEditable) {
    const sel = window.getSelection()
    try {
      if (replace !== false) {
        const range = document.createRange()
        range.selectNodeContents(el)
        sel.removeAllRanges()
        sel.addRange(range)
        document.execCommand('delete', false)
      }
      const range2 = document.createRange()
      range2.selectNodeContents(el)
      range2.collapse(false)
      sel.removeAllRanges()
      sel.addRange(range2)
    } catch (e) { /* selection may be unavailable */ }

    let ok = false
    try {
      ok = document.execCommand('insertText', false, text)
    } catch (e) {
      ok = false
    }
    let strategy = 'execCommand:insertText'
    let got = normalizeForCompare(el.textContent)
    if (!ok || got.indexOf(normalizeForCompare(text)) === -1) {
      // Fallback path for editors that block execCommand.
      strategy = 'InputEvent:insertText'
      el.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: text,
      }))
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, composed: true, inputType: 'insertText', data: text,
      }))
      got = normalizeForCompare(el.textContent)
    }
    return {
      typed: true,
      strategy: strategy,
      verified: got.indexOf(normalizeForCompare(text)) !== -1,
      readback: redact(got).slice(0, 200),
    }
  }

  return { typed: false, strategy: 'unsupported', verified: false, readback: '', error: 'element is not editable' }
}

const KEY_MAP = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  space: { key: ' ', code: 'Space', keyCode: 32 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
}

function parseCombo(combo) {
  const parts = String(combo || '').toLowerCase().split('+').map((p) => p.trim()).filter(Boolean)
  const mods = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }
  let base = null
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') mods.ctrlKey = true
    else if (p === 'shift') mods.shiftKey = true
    else if (p === 'alt') mods.altKey = true
    else if (p === 'meta' || p === 'cmd') mods.metaKey = true
    else base = p
  }
  if (!base) return null
  const known = KEY_MAP[base]
  if (known) return Object.assign({}, known, mods)
  const ch = base.length === 1 ? base : base[0]
  return Object.assign({ key: ch, code: 'Key' + ch.toUpperCase(), keyCode: ch.toUpperCase().charCodeAt(0) }, mods)
}

async function doKeypress(el, combo) {
  const spec = parseCombo(combo)
  if (!spec) return { pressed: false, error: 'unparseable key_combo: ' + combo }
  const target = el || document.activeElement || document.body
  try { target.focus({ preventScroll: true }) } catch (e) { /* ignore */ }
  const init = {
    key: spec.key,
    code: spec.code,
    keyCode: spec.keyCode,
    which: spec.keyCode,
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: spec.ctrlKey,
    shiftKey: spec.shiftKey,
    altKey: spec.altKey,
    metaKey: spec.metaKey,
  }
  target.dispatchEvent(new KeyboardEvent('keydown', init))
  target.dispatchEvent(new KeyboardEvent('keypress', init))
  target.dispatchEvent(new KeyboardEvent('keyup', init))
  return { pressed: true, key: spec.key, combo: combo }
}

// ---------------------------------------------------------------------------
// GENERIC EXTRACTION (gate G4: every returned url must exist as an href in the
// live DOM). Finds >=3 structurally similar sibling containers that each hold a
// price. No site knowledge whatsoever.
// ---------------------------------------------------------------------------
function structuralKey(el) {
  const cls = Array.from(el.classList).slice(0, 3).sort().join('.')
  return el.tagName.toLowerCase() + '|' + cls + '|' + el.children.length
}

function doExtract(params) {
  const maxResults = Math.min(Number(params.max_results) || 25, 25)
  const groups = new Map()

  const candidates = Array.from(document.querySelectorAll('div, li, article, section, a'))
  for (const el of candidates) {
    if (!el.parentElement) continue
    const text = (el.innerText || '').trim()
    if (!text || text.length > 700) continue
    if (!PRICE_REGEX.test(text)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 60 || r.height < 40) continue
    const key = structuralKey(el.parentElement) + '>>' + structuralKey(el)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(el)
  }

  let best = null
  for (const [key, list] of groups.entries()) {
    if (list.length < 3) continue
    if (!best || list.length > best.list.length) best = { key: key, list: list }
  }
  if (!best) {
    return { items: [], reason: 'no repeated priced container group with >=3 members found', groups_examined: groups.size }
  }

  // Gate G4: build the set of hrefs that genuinely exist in this document.
  const liveHrefs = new Set()
  document.querySelectorAll('a[href]').forEach((a) => liveHrefs.add(a.href))

  const items = []
  const seenNames = new Set()
  for (const el of best.list) {
    if (items.length >= maxResults) break
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim()
    const priceMatch = text.match(PRICE_REGEX)
    if (!priceMatch) continue
    const priceInt = parseInt(String(priceMatch[0]).replace(/[^\d]/g, ''), 10)
    if (!Number.isFinite(priceInt)) continue

    const ratingMatch = text.match(/\b([0-5](?:\.\d)?)\s*(?:★|out of 5|stars?|\/\s*5)\b/i)
      || text.match(/\b([0-5]\.\d)\b/)

    const anchor = el.tagName.toLowerCase() === 'a' && el.href ? el : el.querySelector('a[href]')
    const url = anchor && liveHrefs.has(anchor.href) ? anchor.href : ''

    // Name: the longest non-price line in the card.
    const lines = text.split(/\n|\s{2,}/).map((s) => s.trim()).filter(Boolean)
    let name = ''
    for (const ln of lines) {
      if (PRICE_REGEX.test(ln)) continue
      if (ln.length > name.length && ln.length < 140) name = ln
    }
    if (!name) name = text.slice(0, 90)
    const nameKey = name.toLowerCase().slice(0, 50)
    if (seenNames.has(nameKey)) continue
    seenNames.add(nameKey)

    items.push({
      name: redact(name).slice(0, 140),
      price_int: priceInt,
      price_text: priceMatch[0],
      rating: ratingMatch ? Number(ratingMatch[1]) : null,
      url: url,
      url_live: url !== '',
    })
  }

  if (params.text_contains) {
    const needle = String(params.text_contains).toLowerCase()
    return {
      items: items.filter((i) => i.name.toLowerCase().indexOf(needle) !== -1),
      group_size: best.list.length,
      filtered_by: params.text_contains,
    }
  }
  return { items: items, group_size: best.list.length }
}

async function doWait(params) {
  const timeout = Math.min(Number(params.timeout_ms) || 3000, 30000)
  const started = Date.now()
  const needle = params.text_contains ? String(params.text_contains).toLowerCase() : null
  while (Date.now() - started < timeout) {
    if (needle) {
      const body = (document.body ? document.body.innerText || '' : '').toLowerCase()
      if (body.indexOf(needle) !== -1) {
        return { waited_ms: Date.now() - started, matched: true, on: 'text_contains' }
      }
    } else if (document.readyState === 'complete') {
      await sleep(Math.max(0, Math.min(timeout - (Date.now() - started), 250)))
      return { waited_ms: Date.now() - started, matched: true, on: 'readyState' }
    }
    await sleep(200)
  }
  return { waited_ms: Date.now() - started, matched: needle === null, on: needle ? 'text_contains' : 'timeout' }
}

// ---------------------------------------------------------------------------
// Recovery helper: dismiss whatever overlay is on screen, structurally.
// ---------------------------------------------------------------------------
const DISMISS_NAME_REGEX = /^(close|dismiss|no thanks|not now|maybe later|accept all|accept|agree|i agree|got it|ok|okay|continue|allow all|reject all|×|x)$/i

async function doDismissOverlay() {
  const scopes = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]'))
  const pool = scopes.length
    ? scopes.flatMap((s) => Array.from(s.querySelectorAll('button, a[href], [role="button"]')))
    : Array.from(document.querySelectorAll('button, [role="button"]'))

  for (const btn of pool) {
    if (!isVisible(btn)) continue
    const nm = accessibleName(btn).replace(/\s+/g, ' ').trim()
    if (DISMISS_NAME_REGEX.test(nm)) {
      await doClick(btn)
      await sleep(400)
      return { dismissed: true, via: 'button', name: nm }
    }
  }
  await doKeypress(document.body, 'Escape')
  await sleep(300)
  return { dismissed: !detectOverlay(), via: 'escape' }
}

// ---------------------------------------------------------------------------
// ACTION DISPATCH
// ---------------------------------------------------------------------------
async function execute(action) {
  const verb = action.action
  const params = action.params || {}
  const target = action.target || {}

  const needsElement = ['click', 'type', 'hover', 'focus', 'select', 'submit'].indexOf(verb) !== -1
  let el = null
  let how = null
  if (needsElement || (verb === 'keypress' && target.element_id)) {
    const res = resolve(target)
    el = res.el
    how = res.how
    if (!el && needsElement) {
      return { ok: false, error: 'stale_element', detail: 'could not resolve ' + JSON.stringify(target), resolution: how }
    }
  }

  switch (verb) {
    case 'click': {
      const before = { url: location.href, count: document.querySelectorAll('*').length }
      const r = await doClick(el)
      await sleep(350)
      return { ok: true, result: Object.assign({ resolution: how, before: before }, r) }
    }
    case 'type': {
      const r = await doType(el, String(params.text == null ? '' : params.text), params.replace)
      return { ok: r.typed, result: Object.assign({ resolution: how }, r), error: r.typed ? undefined : r.error }
    }
    case 'keypress': {
      const r = await doKeypress(el, params.key_combo)
      await sleep(300)
      return { ok: !!r.pressed, result: r, error: r.error }
    }
    case 'scroll': {
      const amount = Number(params.amount_px) || 600
      const dir = params.direction || 'down'
      const beforeY = window.scrollY
      const dx = dir === 'left' ? -amount : dir === 'right' ? amount : 0
      const dy = dir === 'up' ? -amount : dir === 'down' ? amount : 0
      window.scrollBy({ left: dx, top: dy, behavior: 'instant' })
      await sleep(250)
      return { ok: true, result: { from_y: beforeY, to_y: window.scrollY, direction: dir } }
    }
    case 'hover': {
      await scrollIntoView(el)
      const pt = centerOf(el)
      firePointer(el, 'pointerover', pt)
      fireMouse(el, 'mouseover', pt)
      fireMouse(el, 'mousemove', pt)
      await sleep(250)
      return { ok: true, result: { hovered: true, resolution: how } }
    }
    case 'focus': {
      await scrollIntoView(el)
      el.focus({ preventScroll: true })
      return { ok: document.activeElement === el, result: { focused: document.activeElement === el, resolution: how } }
    }
    case 'select': {
      if (el.tagName.toLowerCase() !== 'select') {
        return { ok: false, error: 'target is not a <select>' }
      }
      const want = String(params.value == null ? '' : params.value)
      const opt = Array.from(el.options).find((o) => o.value === want || (o.textContent || '').trim() === want)
      if (!opt) return { ok: false, error: 'option not found: ' + want }
      el.value = opt.value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true, result: { selected: opt.value } }
    }
    case 'submit': {
      const form = el.tagName.toLowerCase() === 'form' ? el : el.closest('form')
      if (!form) {
        const r = await doClick(el)
        await sleep(500)
        return { ok: true, result: Object.assign({ via: 'click-fallback' }, r) }
      }
      if (typeof form.requestSubmit === 'function') form.requestSubmit()
      else form.submit()
      await sleep(500)
      return { ok: true, result: { submitted: true, via: 'requestSubmit' } }
    }
    case 'wait': {
      const r = await doWait(params)
      return { ok: true, result: r }
    }
    case 'extract': {
      const r = doExtract(params)
      return { ok: true, result: r }
    }
    case 'dismiss_overlay': {
      const r = await doDismissOverlay()
      return { ok: true, result: r }
    }
    default:
      return { ok: false, error: 'unsupported page verb: ' + verb }
  }
}

// ---------------------------------------------------------------------------
// MESSAGE BRIDGE (service worker <-> page)
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false

  if (message.type === 'AGENT_PING') {
    sendResponse({ ok: true, url: location.href, ready: true })
    return true
  }

  if (message.type === 'AGENT_OBSERVE') {
    try {
      sendResponse({ ok: true, observation: walk() })
    } catch (e) {
      sendResponse({ ok: false, error: 'walk failed: ' + e.message })
    }
    return true
  }

  if (message.type === 'AGENT_EXECUTE') {
    execute(message.action)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }))
    return true
  }

  return false
})

console.log('[agent] perception online -', location.href)
