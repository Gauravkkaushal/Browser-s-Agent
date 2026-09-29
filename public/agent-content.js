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

// Bumped whenever the perception or execution behaviour changes. The server
// compares this against the file on disk and says so loudly when Chrome is
// still running an older copy -- a stale content script looks exactly like a
// broken agent, and that is a miserable thing to debug.
const AGENT_BUILD = 'b25-paste-probe-uses-textcontent'

const AGENT_EID = 'agentEid'
const AGENT_NID = 'agentNid'
const MAX_ELEMENTS = 300
const TEXT_CAP = 160
const PAGE_TEXT_CAP = 9000

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
  // Real numbers are written with spaces and hyphens -- "+91 95577 00749" is
  // how a phone book, a chat header and a group member list all render one.
  // Insisting on ten unbroken digits let the commonest form through untouched,
  // which is the only failure here that actually matters.
  // No leading \b: it would never match before "+", leaving the country code
  // stranded next to the redaction marker.
  { type: 'PHONE', regex: /(?:\+?91[\s-]?)?[6-9](?:[\s-]?\d){9}(?!\d)/g },
]

const PRICE_REGEX = /(?:₹|Rs\.?|INR|\$|€|£)\s?[\d,]+(?:\.\d{1,2})?/i

// ---------------------------------------------------------------------------
// Checksum validators. A value is masked either way -- these only say how
// confidently it was CLASSIFIED, which is what precision reporting needs.
// A 16-digit run that fails Luhn is far more often a coupon or order id than
// a card number; a 12-digit run that fails Verhoeff is far more often a
// phone-adjacent number than an Aadhaar. Real, standard checksums -- not
// invented ones -- so they mean the same thing here as anywhere else.
// ---------------------------------------------------------------------------
function luhnValid(raw) {
  const digits = String(raw).replace(/\D/g, '')
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

// Verhoeff checksum (the algorithm UIDAI actually uses for Aadhaar's 12th
// digit) -- multiplication and permutation tables per the standard algorithm.
const VERHOEFF_D = [
  [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],
  [3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
  [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],
  [9,8,7,6,5,4,3,2,1,0],
]
const VERHOEFF_P = [
  [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],
  [8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
  [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8],
]
function verhoeffValid(raw) {
  const digits = String(raw).replace(/\D/g, '')
  if (digits.length !== 12) return false
  let c = 0
  const reversed = digits.split('').reverse()
  for (let i = 0; i < reversed.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][reversed[i].charCodeAt(0) - 48]]
  }
  return c === 0
}

// Field names whose *values* must never leave the page at all.
const PROTECTED_FIELD_REGEX = /password|passwd|\botp\b|cvv|cvc|card\s*number|cardnumber|aadhaar|upi\s*pin|\bpin\b|secret|token/i

// Extra patterns applied above the baseline when the operator asks for more.
// `balanced` adds long digit runs -- account numbers, order ids, membership
// numbers -- that no task needs to reason about. `strict` additionally hides
// person names, which is the strongest setting that still lets the agent work,
// because names the operator typed in their own command are kept.
const STRICTER_PATTERNS = [
  { type: 'DIGITS', regex: /\b\d{6,}\b/g, from: 'balanced' },
  // A bare date is not personal information -- every chat list, inbox and
  // order history is full of them, and blacking them all out hides the page
  // while protecting nothing. Only redact a date that is announced as a birth
  // date.
  { type: 'DOB', regex: /\b(?:dob|d\.?o\.?b|date of birth|born(?: on)?|birth\s*date)\b[:\s-]*\d{1,2}[/\-.]\d{1,2}[/\-.](?:19|20)?\d{2}\b/gi, from: 'balanced' },
  { type: 'ADDRESS', regex: /\b\d{1,4}[,\s]+[A-Za-z][A-Za-z\s]{3,30}(?:Road|Rd|Street|St|Lane|Nagar|Colony|Sector|Block)\b/gi, from: 'balanced' },
  // A person's name is a FULL name: two or more capitalised words in a row.
  //
  // The old pattern was a single capitalised word of three letters or more,
  // which is not a name detector -- it is a detector for "the first word of
  // almost any label". Worse, it ran at `balanced`, the default, contradicting
  // the paragraph above. So every accessible name the reasoner picks controls
  // by was destroyed before the model ever saw it: "Search or start new chat"
  // arrived as "[REDACTED:NAME_01] or start new chat", "Type a message" as
  // "[REDACTED:NAME_02] a message", and "Send" as "[REDACTED:NAME_03]". The
  // agent was left clicking by position, and the capability gate -- which
  // reads the same name to tell a search box from a composer -- saw a field
  // named "...or start new chat" with the word "Search" gone and refused to
  // let a contact's name be typed into contact search.
  { type: 'NAME', regex: /\b[A-Z][a-z]{2,}(?:[ -][A-Z][a-z]{1,}){1,3}\b/g, from: 'strict' },
]

// The furniture of an interface, not a person. Hiding these costs the agent
// its only means of telling one control from another and protects nobody, so a
// NAME match containing any of them is left alone even at `strict`.
const UI_VOCABULARY = new Set((
  'search find filter query results send sent sending type typing message messages chat chats ' +
  'new open close back next previous menu settings profile status home inbox outbox drafts ' +
  'archived starred snoozed spam trash compose reply forward delete remove mute pin unpin ' +
  'read unread online offline today yesterday voice video call attach attachment emoji sticker ' +
  'gif document photo camera group community channel channels update updates contact contacts ' +
  'start stop cancel confirm submit save edit add more options info help account sign login ' +
  'logout download upload share copy link view show hide select all none page tab window ' +
  'button textbox list item row cell dialog input label placeholder google gmail whatsapp'
).split(' '))

function looksLikeUiChrome(match) {
  const tokens = String(match).toLowerCase().split(/[^a-z]+/).filter(Boolean)
  if (!tokens.length) return true
  return tokens.some((t) => UI_VOCABULARY.has(t))
}

// Words the operator used in their own command. Redacting these would make the
// task impossible without protecting anything they have not already said.
let keepTerms = []
let privacyMode = 'balanced'

function isKept(text) {
  const low = String(text).toLowerCase()
  return keepTerms.some((t) => t.length > 2 && low.indexOf(t) !== -1)
}

function activeExtraPatterns() {
  if (privacyMode === 'fast') return []
  if (privacyMode === 'strict') return STRICTER_PATTERNS
  return STRICTER_PATTERNS.filter((p) => p.from === 'balanced')
}

let redactionCounts = {}
// DISTINCT values hidden, per kind.
//
// The counter used to add one per replacement, and redact() runs over every
// element's name, every element's text and the whole page -- so one phone
// number nested in a dozen containers was reported as dozens of redactions.
// A real page produced "2246 PII Masked", which tells a reader nothing and
// quietly invites them to distrust the whole panel. What matters is how many
// SECRETS were hidden, with the number of places as supporting detail.
//
// These sets hold matched values so they can be counted. They are never
// serialised, never sent, and never leave this page -- only their sizes are.
let redactedValues = {}
let redactionOccurrences = {}
// DISTINCT values, per kind, that also passed a real checksum -- see
// luhnValid/verhoeffValid above.
let redactionVerified = {}
// type -> Map(value -> stable surrogate number), reset once per observation.
let redactionIndex = {}

let scanOverlayHost = null
let scanOverlayTimer = null

function showScanOverlay() {
  try {
    hideScanOverlay()
    scanOverlayHost = document.createElement('div')
    scanOverlayHost.setAttribute('data-netrashield-scan', 'true')
    scanOverlayHost.style.position = 'fixed'
    scanOverlayHost.style.inset = '0'
    scanOverlayHost.style.zIndex = '2147483647'
    scanOverlayHost.style.pointerEvents = 'none'
    scanOverlayHost.style.contain = 'strict'

    const root = scanOverlayHost.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = `
      :host { all: initial; }
      .frame {
        position: fixed;
        inset: 0;
        pointer-events: none;
        box-shadow: inset 0 0 0 2px rgba(16, 185, 129, 0.45);
        background: linear-gradient(180deg, rgba(5, 150, 105, 0.04), rgba(14, 165, 233, 0.03));
        overflow: hidden;
      }
      .beam {
        position: absolute;
        left: 0;
        right: 0;
        top: -18%;
        height: 18%;
        background:
          linear-gradient(180deg, transparent 0%, rgba(45, 212, 191, 0.18) 38%, rgba(16, 185, 129, 0.72) 52%, rgba(96, 165, 250, 0.2) 68%, transparent 100%);
        border-top: 1px solid rgba(167, 243, 208, 0.75);
        border-bottom: 1px solid rgba(34, 211, 238, 0.85);
        box-shadow: 0 0 24px rgba(16, 185, 129, 0.42), 0 0 46px rgba(59, 130, 246, 0.24);
        animation: netrashieldScan 1.25s cubic-bezier(0.3, 0, 0.2, 1) infinite;
      }
      .label {
        position: fixed;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        padding: 7px 12px;
        border: 1px solid rgba(16, 185, 129, 0.45);
        border-radius: 8px;
        background: rgba(6, 20, 16, 0.9);
        color: #d1fae5;
        font: 700 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
      }
      @keyframes netrashieldScan {
        from { transform: translateY(0); }
        to { transform: translateY(650%); }
      }
    `
    const frame = document.createElement('div')
    frame.className = 'frame'
    const beam = document.createElement('div')
    beam.className = 'beam'
    const label = document.createElement('div')
    label.className = 'label'
    label.textContent = 'NetraShield scanning page'
    frame.appendChild(beam)
    frame.appendChild(label)
    root.appendChild(style)
    root.appendChild(frame)
    document.documentElement.appendChild(scanOverlayHost)
    scanOverlayTimer = setTimeout(hideScanOverlay, 1800)
  } catch (e) {
    scanOverlayHost = null
  }
}

function hideScanOverlay() {
  if (scanOverlayTimer) {
    clearTimeout(scanOverlayTimer)
    scanOverlayTimer = null
  }
  if (scanOverlayHost && scanOverlayHost.parentNode) {
    scanOverlayHost.parentNode.removeChild(scanOverlayHost)
  }
  scanOverlayHost = null
}

/**
 * Records one redaction and returns a stable per-type, per-value surrogate
 * number -- the same real phone number always gets the same "_02" within one
 * observation, so a reasoner tracking "the number from step 1" can tell it
 * apart from a different one, without ever seeing either value.
 */
function noteRedaction(type, match) {
  if (!redactedValues[type]) redactedValues[type] = new Set()
  if (!redactionIndex[type]) redactionIndex[type] = new Map()
  const key = String(match).replace(/\s+/g, '')
  const isNew = !redactedValues[type].has(key)
  redactedValues[type].add(key)
  redactionOccurrences[type] = (redactionOccurrences[type] || 0) + 1
  redactionCounts[type] = redactedValues[type].size
  if (isNew) {
    redactionIndex[type].set(key, redactionIndex[type].size + 1)
    let verified = false
    if (type === 'CARD') verified = luhnValid(match)
    else if (type === 'AADHAAR') verified = verhoeffValid(match)
    if (verified) {
      if (!redactionVerified[type]) redactionVerified[type] = new Set()
      redactionVerified[type].add(key)
    }
  }
  return redactionIndex[type].get(key)
}

function surrogate(type, match) {
  const n = noteRedaction(type, match)
  return '[REDACTED:' + type + '_' + String(n).padStart(2, '0') + ']'
}

function redact(text) {
  if (!text) return ''
  let out = String(text).replace(/\s+/g, ' ').trim()
  for (const p of PII_PATTERNS) {
    p.regex.lastIndex = 0
    out = out.replace(p.regex, (match) => surrogate(p.type, match))
  }
  for (const p of activeExtraPatterns()) {
    p.regex.lastIndex = 0
    out = out.replace(p.regex, (match) => {
      // Never hide what the operator themselves asked for.
      if (isKept(match)) return match
      // ...nor the interface's own furniture, which is how the agent steers.
      if (p.type === 'NAME' && looksLikeUiChrome(match)) return match
      return surrogate(p.type, match)
    })
  }
  return out
}

/** Which kinds of PII are in this text. The kind is reportable; the value never is. */
function kindsIn(text) {
  if (!text) return []
  const out = []
  for (const p of PII_PATTERNS.concat(activeExtraPatterns())) {
    p.regex.lastIndex = 0
    if (p.regex.test(text) && !isKept(text)) out.push(p.type)
  }
  return out
}

function hasPii(text) {
  if (!text) return false
  const all = PII_PATTERNS.concat(activeExtraPatterns())
  return all.some((p) => {
    p.regex.lastIndex = 0
    return p.regex.test(text) && !isKept(text)
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

/*
 * A form control the eye can see but this code nearly threw away.
 *
 * The custom toggle/switch is one of the most common patterns on the web: the
 * real <input type="checkbox"> is made invisible (opacity:0, or clipped to a
 * 1px sr-only box) and a styled <span> track and thumb are drawn in its place
 * inside the same <label>. The control is fully visible to a human and fully
 * operable by a mouse -- but the element that carries the checked state fails
 * every test in isVisible(), so it never reached the observation at all.
 *
 * That is how an attendance roster of fourteen named toggles showed up to the
 * agent as two buttons and nothing else. With no per-student control to see,
 * "mark everyone except Gaurav" had no way to finish: the model clicked "Mark
 * all present", looked for Gaurav's row, could not find it, clicked "Clear
 * all" to start over, and went round that loop until a human stopped it. The
 * flip-flopping was not confusion -- it was the only move left on a page it
 * was being shown half of.
 *
 * So when a control fails the visibility test on its own, look for the visible
 * thing that stands in for it: its wrapping <label>, its label[for=...], or a
 * small visible ancestor. If that proxy is visible, the control is visible --
 * and the proxy's rect is where a real mouse would click it.
 */
function visualProxy(el) {
  const tag = el.tagName.toLowerCase()
  const role = (el.getAttribute('role') || '').toLowerCase()
  const proxyable = tag === 'input' || tag === 'select' || tag === 'textarea'
    || role === 'checkbox' || role === 'radio' || role === 'switch'
  if (!proxyable) return null

  const candidates = []
  try {
    if (el.id) {
      const forLabel = document.querySelector('label[for="' + CSS.escape(el.id) + '"]')
      if (forLabel) candidates.push(forLabel)
    }
    const wrapping = el.closest ? el.closest('label') : null
    if (wrapping) candidates.push(wrapping)
  } catch (e) { /* CSS.escape can throw on exotic ids */ }

  // Fall back to the nearest ancestors, but only small ones: a styled switch
  // lives a node or two above the input, while a whole <form> or page section
  // would hand back a rect that clicks the wrong thing entirely.
  let p = el.parentElement
  for (let i = 0; i < 3 && p; i++) {
    candidates.push(p)
    p = p.parentElement
  }

  for (const c of candidates) {
    if (!c || c === document.body || c === document.documentElement) continue
    let r
    let st
    try {
      r = c.getBoundingClientRect()
      st = window.getComputedStyle(c)
    } catch (e) { continue }
    if (!isVisible(c, r, st)) continue
    // Big enough to be seen and clicked, small enough to still BE the control.
    if (r.width > 240 || r.height > 120) continue
    return { el: c, rect: r }
  }
  return null
}

/*
 * Where a click on this element should actually land. For an ordinary element
 * that is its own box; for a visually-hidden control it is the box of the
 * visible proxy the user would aim at.
 */
function interactionRect(el) {
  let rect
  let style
  try {
    rect = el.getBoundingClientRect()
    style = window.getComputedStyle(el)
  } catch (e) {
    return el.getBoundingClientRect()
  }
  if (isVisible(el, rect, style)) return rect
  const proxy = visualProxy(el)
  return proxy ? proxy.rect : rect
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
  const host = location.hostname
  // A bare IP or a loopback name has no brand label to extract.
  if (!host || host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.indexOf(':') !== -1) {
    return 'generic'
  }
  const parts = host.split('.').filter((p) => p && p !== 'www')
  if (parts.length === 0) return 'generic'
  const generic = ['com', 'net', 'org', 'co', 'in', 'io', 'app', 'web', 'mail', 'accounts']
  const meaningful = parts.filter((p) => generic.indexOf(p) === -1)
  return (meaningful[meaningful.length - 1] || parts[0]).toLowerCase()
}

const SIGNIN_WORDING = /\b(sign in|signin|log in|login|continue with|use another account|forgot password|create account)\b/i

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

  // Signal 2: a credential wall. A password field ALONE is not enough -- plenty
  // of ordinary pages (account settings, a saved customer record) contain one
  // without being a sign-in gate, and treating those as a wall would stall the
  // loop waiting for a human who has nothing to do. Require corroboration: the
  // URL looks like a sign-in flow, or the page is dominated by sign-in wording
  // with an identifier field beside the password.
  const signinUrl = /(^|\/)(signin|sign-in|sign_in|login|log-in|auth|oauth|challenge)(\/|\?|$)/i.test(location.pathname + location.search)
  const identifier = document.querySelector('input[type="email"], input[name*="identifier" i], input[name*="email" i], input[autocomplete="username"]')
  const pwd = Array.from(document.querySelectorAll('input[type="password"]')).find((el) => isVisible(el))
  const signinSubmit = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]'))
    .filter((el) => isVisible(el))
    .some((el) => SIGNIN_WORDING.test(accessibleName(el)))

  // A second factor (an emailed or texted one-time code) is part of the same
  // wall: the URL still looks like a sign-in flow and the identifier field is
  // usually still present, even though the password field is gone by then.
  const otpWording = /\b(one[- ]?time code|verification code|otp)\b/i.test(bodyText)
  const otpField = document.querySelector('input[autocomplete="one-time-code"], input[name*="otp" i]')

  if (signinUrl && (identifier || pwd)) {
    const hint = (!pwd && (otpField || otpWording))
      ? 'Sign in, then enter the one-time code sent to your email to continue.'
      : 'Sign in with your account to continue.'
    return { app: appNameFromHost(), kind: 'credential', hint: hint }
  }
  if (pwd && identifier && signinSubmit) {
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

// A single-page app reports `document.readyState === 'complete'` the moment its
// empty shell has downloaded -- long before its own JS has fetched, rendered
// and settled the actual screen (an inbox list, a QR canvas, whatever the real
// content is). Treating that shell as "loaded" is how a page gets judged, or
// given up on, before it has actually happened: generic, no site names.
function isStillBootstrapping(elementCount) {
  const total = document.body ? document.body.querySelectorAll('*').length : 0
  // A near-empty document after the shell has downloaded is still bootstrapping.
  if (total < 25 && elementCount === 0) return true
  // A visible, sizeable spinner/progress indicator with nothing yet to act on.
  const spinner = Array.from(document.querySelectorAll(
    '[role="progressbar"], [aria-busy="true"], [class*="spinner" i], [class*="loader" i], [class*="loading" i]'
  )).find((el) => {
    const r = el.getBoundingClientRect()
    return isVisible(el, r) && r.width * r.height > 400
  })
  if (spinner && elementCount === 0) return true
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
  redactedValues = {}
  redactionOccurrences = {}
  redactionVerified = {}
  redactionIndex = {}
  const started = performance.now()
  const errors = []
  const sensitiveBoxes = []
  // What each mask is for. Kinds, never values.
  const maskedRegions = []
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

  // Rank before capping.
  //
  // Walking in DOM order and stopping at a limit is how an agent goes blind on
  // a real application: a chat sidebar with hundreds of rows will consume the
  // entire budget before the walker ever reaches the message box at the bottom
  // of the document. What is on screen matters far more than what comes first
  // in the markup, so score everything cheaply, then keep the best.
  const scored = []
  const seen = new Set()
  for (const el of raw) {
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
    if (!isVisible(el, rect, style)) {
      // A styled toggle hides its real input. Measure it by the visible thing
      // that stands in for it, and keep it: the input is what holds `checked`.
      const proxy = visualProxy(el)
      if (!proxy) continue
      rect = proxy.rect
    }
    const onScreen = rect.bottom > 0 && rect.right > 0
      && rect.top < window.innerHeight && rect.left < window.innerWidth
    const tag = el.tagName.toLowerCase()
    const editable = isEditable(el)
    let score = 0
    if (onScreen) score += 1000
    // A place to type is the scarcest and most valuable thing on a page.
    if (editable) score += 400
    if (['button', 'a', 'input', 'textarea', 'select'].indexOf(tag) !== -1) score += 60
    const role = el.getAttribute('role') || ''
    if (role === 'button' || role === 'textbox' || role === 'searchbox') score += 60
    // Long lists of identical rows are worth sampling, not exhausting.
    if (role === 'listitem' || role === 'row' || role === 'gridcell') score -= 20
    scored.push({ el: el, rect: rect, style: style, score: score })
  }
  scored.sort((a, b) => b.score - a.score || a.rect.top - b.rect.top)

  const elements = []
  let n = 0

  for (const entry of scored) {
    if (elements.length >= MAX_ELEMENTS) break
    const el = entry.el
    const rect = entry.rect
    const style = entry.style

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
      // A checkbox/radio's `.value` is its HTML value ATTRIBUTE (default "on"),
      // which says nothing about whether it is actually checked -- report the
      // state that matters instead, so a task that toggles a list of items can
      // be verified afterwards from the observation alone.
      const inputType = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : ''
      if (inputType === 'checkbox' || inputType === 'radio') {
        value = el.checked ? 'checked' : 'unchecked'
      } else {
        const v = el.value !== undefined && el.value !== null ? el.value : (el.textContent || '')
        if (protectedField) {
          value = v ? '[PROTECTED INPUT] len=' + String(v).length : ''
        } else {
          value = redact(String(v).slice(0, TEXT_CAP))
        }
      }
    }

    const eid = 'e' + n
    n += 1
    el.dataset[AGENT_EID] = eid
    const nid = computeNid(el, rect, rawName)
    el.dataset[AGENT_NID] = nid

    const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth

    // A field holding a secret is always covered. Otherwise judge the element
    // on the text it OWNS, never on everything nested inside it: a chat row's
    // innerText sweeps up the name, the preview and the timestamp, so one
    // number anywhere inside blacks out the whole row. The number's own line
    // is a separate element and gets covered on its own merits.
    let ownText = ''
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) ownText += node.textContent || ''
    }
    ownText = ownText.replace(/\s+/g, ' ').trim()
    const smallEnough = rect.width * rect.height
      <= window.innerWidth * window.innerHeight * 0.06
    if (protectedField || (smallEnough && hasPii(ownText))) {
      // CSS pixels. The screenshot's true scale is measured when it is taken,
      // because the captured bitmap does not reliably equal viewport * dpr.
      sensitiveBoxes.push([
        Math.round(rect.left), Math.round(rect.top),
        Math.round(rect.width), Math.round(rect.height),
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
  //
  // Match on an element's OWN text, not everything nested inside it. A chat row
  // is a container: if one line deep inside it holds a phone number, matching on
  // innerText blacks out the entire row -- name, preview, timestamp and all --
  // which hides far more than it protects and makes the page unreadable.
  // Redaction has to be surgical or nobody will trust it.
  try {
    const MAX_MASK_AREA = window.innerWidth * window.innerHeight * 0.06
    // Scan far enough to reach the whole page, not just its beginning.
    //
    // This was capped at 900 in DOM ORDER, and a chat app puts thousands of
    // elements in the conversation list before it gets to the side panel -- so
    // the contact's phone number, sitting in that panel in plain sight, was
    // never even looked at. Missing the one number on screen while blacking
    // out a video thumbnail is the exact opposite of the job.
    //
    // The cap can be this high because the expensive part is measured LAST:
    // hasPii() is plain string work, and getBoundingClientRect -- which forces
    // layout -- only runs for elements that actually contain something.
    const blocks = Array.from(document.querySelectorAll(
      'p, span, td, th, li, label, h1, h2, h3, h4, dd, dt, a, b, strong, em, code, div',
    )).slice(0, 8000)

    for (const b of blocks) {
      // Only the text this element owns directly. Anything inside a child will
      // be caught when we reach that child.
      let own = ''
      for (const node of b.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) own += node.textContent || ''
      }
      own = own.replace(/\s+/g, ' ').trim()
      if (!own || own.length > 240) continue
      if (!hasPii(own)) continue

      const r = b.getBoundingClientRect()
      if (!isVisible(b, r)) continue
      // A mask the size of a panel is a mistake, not a redaction.
      if (r.width * r.height > MAX_MASK_AREA) continue

      sensitiveBoxes.push([
        Math.round(r.left), Math.round(r.top),
        Math.round(r.width), Math.round(r.height),
      ])
      // Say what this box covers -- the KIND only, never the value. A count
      // with nothing behind it cannot be checked; "PHONE at 1519,297" can.
      maskedRegions.push({
        kind: kindsIn(own).join('+') || 'PII',
        box: [Math.round(r.left), Math.round(r.top),
              Math.round(r.width), Math.round(r.height)],
      })
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

  // The readable text of the page, redacted.
  //
  // Interactive elements alone are not an observation -- they are a list of
  // things to press. Prices, article copy, confirmation banners and every other
  // answer the user actually asked for live in ordinary text nodes. Without
  // this the agent can operate a page but cannot read one.
  let pageText = ''
  try {
    const main = document.querySelector('main, [role="main"], article') || document.body
    pageText = redact((main.innerText || '').replace(/\n{3,}/g, '\n\n').trim()).slice(0, PAGE_TEXT_CAP)
  } catch (e) {
    errors.push('page-text: ' + e.message)
  }

  const forms = Array.from(document.querySelectorAll('form')).slice(0, 12).map((f, i) => ({
    index: i,
    name: redact(f.getAttribute('name') || f.getAttribute('id') || '').slice(0, 60),
    field_count: f.querySelectorAll('input, textarea, select').length,
  }))

  // Draw live masks on the screen for the hackathon demo!
  try {
    document.querySelectorAll('.agent-live-mask').forEach((el) => el.remove())
    if (sensitiveBoxes.length > 0 && document.body) {
      for (const b of sensitiveBoxes) {
        const div = document.createElement('div')
        div.className = 'agent-live-mask'
        div.style.position = 'absolute'
        div.style.left = (b[0] + window.scrollX) + 'px'
        div.style.top = (b[1] + window.scrollY) + 'px'
        div.style.width = b[2] + 'px'
        div.style.height = b[3] + 'px'
        div.style.backgroundColor = '#111827'
        div.style.color = 'rgba(255, 255, 255, 0.4)'
        div.style.display = 'flex'
        div.style.alignItems = 'center'
        div.style.justifyContent = 'center'
        div.style.fontSize = '10px'
        div.style.fontWeight = 'bold'
        div.style.borderRadius = '2px'
        div.style.zIndex = '2147483647' // Maximum possible z-index
        div.style.pointerEvents = 'none' // Don't block clicks!
        if (b[2] > 40 && b[3] > 15) {
          div.innerText = 'REDACTED'
        }
        document.body.appendChild(div)
      }
    }
  } catch (e) {
    // ignore
  }

  return {
    url: location.href,
    title: redact(document.title || location.hostname).slice(0, 160),
    page_kind: detectPageKind(),
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: dpr },
    scroll: {
      x: Math.round(window.scrollX),
      y: Math.round(window.scrollY),
      max_y: Math.max(0, Math.round((document.documentElement.scrollHeight || 0) - window.innerHeight)),
    },
    page_state: {
      loading: document.readyState !== 'complete' || isStillBootstrapping(elements.length),
      overlay_present: detectOverlay(),
      login_wall: detectLoginWall(),
    },
    interactive_elements: elements,
    page_text: pageText,
    dom_summary: {
      element_count: document.querySelectorAll('*').length,
      interactive_count: elements.length,
      forms: forms,
    },
    focused_element: focusedInfo,
    screenshot: null,
    sensitive_boxes: sensitiveBoxes.slice(0, 200),
    masked_regions: maskedRegions.slice(0, 200),
    errors: errors,
    pii_redactions: Object.assign({}, redactionCounts),
    pii_occurrences: Object.assign({}, redactionOccurrences),
    pii_verified: Object.fromEntries(
      Object.keys(redactionVerified).map((k) => [k, redactionVerified[k].size])
    ),
    agent_build: AGENT_BUILD,
    privacy_mode: privacyMode,
    walk_ms: Math.round(performance.now() - started),
    observed_at: new Date().toISOString(),
  }
}

/**
 * What KIND of document this is, when it is not ordinary HTML.
 *
 * Chrome renders a PDF with its built-in viewer, and that viewer is a plugin
 * document: the DOM contains an <embed> and nothing else. Walking it finds no
 * text and no controls, which looks exactly like a broken page -- so the agent
 * scrolls, waits, switches tabs and eventually gives up, when the truth is
 * simply that the words are not in the DOM at all. Naming the kind lets the
 * loop fetch and read the file instead of hunting for elements that cannot
 * exist.
 */
function detectPageKind() {
  try {
    if ((document.contentType || '').toLowerCase() === 'application/pdf') return 'pdf'
    const embed = document.querySelector('embed[type="application/pdf"], object[type="application/pdf"]')
    if (embed) return 'pdf'
    if (/\.pdf(?:[?#]|$)/i.test(location.pathname + location.search)) return 'pdf'
  } catch (e) { /* ignore */ }
  return 'html'
}

/** Read a document's bytes as base64, with the page's own credentials. */
const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024

async function fetchDocumentBytes(url) {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) {
    return { ok: false, error: 'fetching the document returned HTTP ' + res.status }
  }
  const buf = await res.arrayBuffer()
  if (buf.byteLength > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      error: 'the document is ' + Math.round(buf.byteLength / 1048576) + 'MB, over the '
        + Math.round(MAX_DOCUMENT_BYTES / 1048576) + 'MB limit',
    }
  }
  const bytes = new Uint8Array(buf)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return {
    ok: true,
    url: url,
    bytes: bytes.length,
    content_type: res.headers.get('content-type') || '',
    data: btoa(binary),
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
  await sleep(70)
}

// True when both nodes belong to the same <label>: the styled parts of one
// custom control, not one element covering an unrelated one.
function sharesLabel(el, other) {
  try {
    const lab = el.closest ? el.closest('label') : null
    return !!(lab && lab.contains(other))
  } catch (e) {
    return false
  }
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
  // For a visually-hidden control this is its visible proxy's box, which is
  // where a real mouse would land; for everything else it is the element.
  const aim = interactionRect(el)
  const pt = { x: Math.round(aim.left + aim.width / 2), y: Math.round(aim.top + aim.height / 2) }

  // Click what is actually under the pointer, the way a real mouse does.
  //
  // Application UIs routinely put the handler on an inner node: a chat list row
  // is a container, but the thing that opens the conversation is a descendant.
  // Dispatching on the container alone means the event never reaches the
  // listener and the click silently does nothing -- the page looks unchanged
  // and the agent concludes it must try again.
  let target = el
  let occludedBy = null
  try {
    const top = document.elementFromPoint(pt.x, pt.y)
    if (top) {
      if (el.contains(top)) {
        target = top          // an inner node: exactly what a mouse would hit
      } else if (top !== el && !top.contains(el) && sharesLabel(el, top)) {
        // The styled track/thumb of a custom switch sits over its own input.
        // That is not an obstruction, it is the part a mouse is meant to hit:
        // clicking it activates the label, which activates the control.
        target = top
      } else if (top !== el && !top.contains(el)) {
        // Something unrelated is covering the element. Say so, and click it
        // anyway is NOT the answer -- report it and let the loop decide.
        occludedBy = redact(accessibleName(top)).slice(0, 60) || top.tagName.toLowerCase()
      }
    }
  } catch (e) { /* elementFromPoint can throw on detached nodes */ }

  try { (target.focus ? target : el).focus({ preventScroll: true }) } catch (e) { /* ignore */ }

  // Watch for ANY reaction, not just a change in how many nodes exist.
  //
  // The count was a bad proxy and it made this function undo its own work. A
  // menu button is a TOGGLE: the first click opens it, a second closes it. If
  // the menu had not finished rendering when the count was compared -- and 120
  // milliseconds is not long for a framework menu -- the fallback fired a
  // second, native click and shut the menu again. The page ended up exactly as
  // it started, so the agent concluded the click had failed and tried again,
  // and again, and again, each attempt cancelling itself the same way.
  //
  // A mutation observer sees what the count misses: a menu opening flips
  // aria-expanded, adds a class, moves focus. Any of that is proof the element
  // reacted and no fallback is wanted.
  let reacted = false
  let observer = null
  try {
    observer = new MutationObserver(() => { reacted = true })
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true,
    })
  } catch (e) { /* observation is an optimisation, not a requirement */ }

  // A checkbox/radio's `checked` is an IDL property, not a reflected HTML
  // attribute -- toggling it mutates neither childList nor attributes, so the
  // observer above is structurally blind to it. Without this, a dispatched
  // click that DID toggle the box looks identical to one that did nothing,
  // the code below reaches for the native-activation fallback either way, and
  // that second `.click()` flips the box straight back to where it started.
  const isCheckable = el.tagName === 'INPUT' &&
    (el.type === 'checkbox' || el.type === 'radio')
  const beforeChecked = isCheckable ? el.checked : null

  const beforeFocus = document.activeElement
  firePointer(target, 'pointerdown', pt)
  fireMouse(target, 'mousedown', pt)
  firePointer(target, 'pointerup', pt)
  fireMouse(target, 'mouseup', pt)
  fireMouse(target, 'click', pt)

  // Give a real UI time to respond before deciding it did not.
  await sleep(320)
  if (observer) { try { observer.disconnect() } catch (e) { /* ignore */ } }
  if (document.activeElement !== beforeFocus) reacted = true
  if (isCheckable && el.checked !== beforeChecked) reacted = true

  // Only when NOTHING stirred is a native activation worth trying.
  let usedNativeFallback = false
  if (!reacted) {
    const clickable = (target.closest && target.closest('a[href],button,[role="button"],[role="listitem"],[role="row"],[onclick]')) || el
    try {
      clickable.click()
      usedNativeFallback = true
      await sleep(150)
    } catch (e) { /* ignore */ }
  }

  return {
    clicked: true,
    occluded_by: occludedBy,
    point: pt,
    dispatched_on: target === el
      ? 'the element itself'
      : (target.tagName || '?').toLowerCase() + ' inside it',
    native_fallback: usedNativeFallback,
    // Whether the page visibly reacted. The verifier can use this to tell a
    // click that did nothing from one whose effect it simply cannot name.
    page_reacted: reacted,
  }
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
  // A tab character means this is a TABLE, not a value.
  //
  // The agent reached for `type` twice after paste_table reported failure, and
  // typed a whole tab-separated block into one cell. A field holds one value,
  // so the rows collapse -- but the readback still matched closely enough to
  // report success, and the task was announced as done over a spreadsheet
  // containing one mangled cell. Refusing here is the only place that failure
  // can be made visible, because by the time it is typed it looks fine.
  //
  // Tab is safe to key on: it moves focus, so nobody ever means to type one
  // into a field. Plain newlines are left alone -- a two-line chat message is
  // perfectly ordinary.
  if (String(text).indexOf('\t') !== -1) {
    return {
      typed: false,
      verified: false,
      strategy: 'refused',
      error: 'this text is tab-separated, so it is a table, not a value. A field '
        + 'holds ONE value: typing rows into it collapses them into a single '
        + 'cell that reads back as though it worked. Use `paste_table` instead.',
    }
  }

  await scrollIntoView(el)
  try { el.focus({ preventScroll: true }) } catch (e) { /* ignore */ }
  await sleep(35)

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
    await sleep(60)
    const got = normalizeForCompare(el.value)
    return {
      typed: true,
      strategy: 'native-value-setter',
      verified: got.indexOf(normalizeForCompare(text)) !== -1,
      readback: redact(got).slice(0, 200),
    }
  }

  if (el.isContentEditable) {
    // Rich editors (Lexical, Draft, ProseMirror) keep their own document model
    // and only update the DOM in response to events they recognise. There is no
    // single technique that works everywhere, so try the realistic ones in
    // order and read the field back after each -- with a beat in between,
    // because these editors render asynchronously and an immediate readback
    // reports failure on a change that is about to land.
    const wanted = normalizeForCompare(text)
    const readback = () => normalizeForCompare(el.innerText || el.textContent || '')
    const landed = () => readback().indexOf(wanted) !== -1

    const placeCaret = () => {
      try {
        const sel = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(el)
        if (replace === false) range.collapse(false)
        sel.removeAllRanges()
        sel.addRange(range)
        if (replace !== false) document.execCommand('delete', false)
      } catch (e) { /* selection may be unavailable */ }
    }

    const attempts = [
      // 1. The standard editing command. Produces real beforeinput/input
      //    events, which is what most editors listen for.
      ['execCommand:insertText', () => {
        placeCaret()
        try { document.execCommand('insertText', false, text) } catch (e) { /* ignore */ }
      }],
      // 2. A paste. Editors that ignore synthetic key input almost always
      //    honour a paste, because that is how a real user drops in text.
      ['clipboard:paste', () => {
        placeCaret()
        try {
          const dt = new DataTransfer()
          dt.setData('text/plain', text)
          el.dispatchEvent(new ClipboardEvent('paste', {
            clipboardData: dt, bubbles: true, cancelable: true, composed: true,
          }))
        } catch (e) { /* DataTransfer unavailable */ }
      }],
      // 3. Raw input events, for editors that build from beforeinput alone.
      ['InputEvent:insertText', () => {
        placeCaret()
        el.dispatchEvent(new InputEvent('beforeinput', {
          bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: text,
        }))
        el.dispatchEvent(new InputEvent('input', {
          bubbles: true, composed: true, inputType: 'insertText', data: text,
        }))
      }],
      // 4. Last resort: write the text in and tell the editor it changed.
      ['textContent+input', () => {
        try {
          el.textContent = replace === false ? (el.textContent || '') + text : text
          el.dispatchEvent(new InputEvent('input', {
            bubbles: true, composed: true, inputType: 'insertText', data: text,
          }))
        } catch (e) { /* ignore */ }
      }],
    ]

    const tried = []
    for (const attempt of attempts) {
      const name = attempt[0]
      tried.push(name)
      attempt[1]()
      await sleep(90)
      if (landed()) {
        return {
          typed: true,
          strategy: name,
          strategies_tried: tried,
          verified: true,
          readback: redact(readback()).slice(0, 200),
        }
      }
    }

    return {
      typed: false,
      strategy: 'none of ' + tried.length + ' strategies worked',
      strategies_tried: tried,
      verified: false,
      readback: redact(readback()).slice(0, 200),
      error: 'this editor did not accept any of the standard text-entry methods',
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

const LEADING_NUMBER = /-?\d+(?:\.\d+)?/

/**
 * How much a repeated group looks like DATA rather than navigation.
 *
 * Size alone picks the site's link bar on most pages: it is the biggest
 * repeated group there is and every member is three words long. Rows of
 * records almost always carry a number -- a magnitude, a date, a score, a
 * count -- and a nav bar almost never does.
 */
function scoreGroup(list, requirePrice) {
  if (requirePrice) return list.length
  let totalLen = 0
  let withDigits = 0
  for (const el of list) {
    const t = (el.innerText || '').replace(/\s+/g, ' ').trim()
    totalLen += t.length
    if (/\d/.test(t)) withDigits += 1
  }
  if (totalLen / list.length < 12) return 0
  return list.length * (1 + (withDigits / list.length) * 2)
}

/**
 * Read a repeated list off the page.
 *
 * This was a shopping-card scraper and nothing else: every candidate had to
 * contain a price, so `extract` returned zero items on any page that was not a
 * storefront. That is not a niche gap. Extraction is how a value gets ON THE
 * RECORD -- capability_gate treats extracted items as vouched -- so a page the
 * extractor cannot read is a page whose data can never be typed anywhere else.
 * A list of earthquakes, flights, fixtures or search results would be read by
 * the agent, refused by the gate on its way out, and the task would die with
 * the data plainly visible on screen the whole time.
 *
 * The priced pass still runs first and keeps its tuned price/rating parsing,
 * because a storefront is the case most likely to also have a larger group of
 * nav links that would win on size alone.
 */
function doExtract(params) {
  const maxResults = Math.min(Number(params.max_results) || 25, 25)
  const priced = collectRepeatedGroup(params, maxResults, true)
  if (priced.items && priced.items.length) return priced
  const generic = collectRepeatedGroup(params, maxResults, false)
  if (generic.items && generic.items.length) return generic
  return {
    items: [],
    reason: generic.reason || priced.reason || 'no repeated group found',
    groups_examined: generic.groups_examined || 0,
  }
}

// Tags that are never themselves a row of data: page furniture, drawing
// primitives and leaf controls. Everything else is a candidate, INCLUDING tags
// this file has never heard of.
const NOT_A_ROW = new Set([
  'html', 'head', 'body', 'script', 'style', 'meta', 'link', 'title', 'noscript',
  'svg', 'path', 'g', 'circle', 'rect', 'defs', 'use', 'canvas', 'img', 'picture',
  'source', 'br', 'hr', 'input', 'textarea', 'select', 'option', 'iframe',
])
// Enough to cover a long list page without turning extraction into a scan of
// the whole document on an application that renders thousands of nodes.
const MAX_CANDIDATES = 4000

function collectRepeatedGroup(params, maxResults, requirePrice) {
  const groups = new Map()

  // A tag whitelist ('div, li, article, section, tr, a') looks reasonable and
  // silently fails on exactly the sites worth automating. Angular and Web
  // Component applications render rows as custom elements -- <mat-list-item>,
  // <app-event-row> -- which match none of those names, so the extractor would
  // walk the whole page and find nothing while the rows sat there in plain
  // sight. Ask what an element IS, not what it is called.
  let candidates = Array.from(document.querySelectorAll('*'))
  if (candidates.length > MAX_CANDIDATES) candidates = candidates.slice(0, MAX_CANDIDATES)
  for (const el of candidates) {
    if (NOT_A_ROW.has(el.tagName.toLowerCase())) continue
    if (!el.parentElement) continue
    const text = (el.innerText || '').trim()
    if (!text || text.length > 700) continue
    if (requirePrice) {
      if (!PRICE_REGEX.test(text)) continue
    } else if (text.length < 8) continue
    const r = el.getBoundingClientRect()
    // A list row is much shorter than a product card, so the generic pass
    // cannot inherit the card-shaped minimum height.
    if (r.width < 60 || r.height < (requirePrice ? 40 : 18)) continue
    const key = structuralKey(el.parentElement) + '>>' + structuralKey(el)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(el)
  }

  let best = null
  for (const [key, list] of groups.entries()) {
    if (list.length < 3) continue
    const score = scoreGroup(list, requirePrice)
    if (score <= 0) continue
    if (!best || score > best.score) best = { key: key, list: list, score: score }
  }
  if (!best) {
    return {
      items: [],
      reason: requirePrice
        ? 'no repeated priced container group with >=3 members found'
        : 'no repeated container group with >=3 members found',
      groups_examined: groups.size,
    }
  }

  // Gate G4: build the set of hrefs that genuinely exist in this document.
  const liveHrefs = new Set()
  document.querySelectorAll('a[href]').forEach((a) => liveHrefs.add(a.href))

  const items = []
  const seenNames = new Set()
  for (const el of best.list) {
    if (items.length >= maxResults) break
    // Keep the raw innerText as well: its line breaks are how a card separates
    // its title from its price, and the name picker below relies on them.
    const rawText = (el.innerText || '').trim()
    const text = rawText.replace(/\s+/g, ' ').trim()
    const priceMatch = text.match(PRICE_REGEX)
    if (requirePrice && !priceMatch) continue
    let priceInt = priceMatch
      ? parseInt(String(priceMatch[0]).replace(/[^\d]/g, ''), 10)
      : null
    if (priceInt !== null && !Number.isFinite(priceInt)) {
      if (requirePrice) continue
      priceInt = null
    }

    const ratingMatch = text.match(/\b([0-5](?:\.\d)?)\s*(?:★|out of 5|stars?|\/\s*5)\b/i)
      // A bare "4.3" only means a rating on a page that sells things. On a
      // list of earthquakes it is the magnitude, and calling it a rating
      // would put the wrong number in the wrong column.
      || (requirePrice ? text.match(/\b([0-5]\.\d)\b/) : null)

    const anchor = el.tagName.toLowerCase() === 'a' && el.href ? el : el.querySelector('a[href]')
    const url = anchor && liveHrefs.has(anchor.href) ? anchor.href : ''

    // Name: the longest line in the card that is not itself a price or a bare
    // rating. Cards put the title on its own line, which is why the raw
    // innerText is kept above -- normalising whitespace first would destroy
    // exactly the line breaks this depends on.
    const lines = rawText.split(/\n+/).map((s) => s.trim()).filter(Boolean)
    let name = ''
    for (const ln of lines) {
      if (PRICE_REGEX.test(ln)) continue
      if (/^[0-5](\.\d)?\s*(out of 5|stars?|★)?$/i.test(ln)) continue
      if (ln.length > name.length && ln.length < 140) name = ln
    }
    if (!name) name = text.replace(PRICE_REGEX, '').trim().slice(0, 90)
    const nameKey = name.toLowerCase().slice(0, 50)
    if (seenNames.has(nameKey)) continue
    seenNames.add(nameKey)

    const numberMatch = text.match(LEADING_NUMBER)

    const item = {
      name: redact(name).slice(0, 140),
      // The whole row, and its lines. A task about something other than
      // shopping needs the fields this parser knows nothing about -- a
      // magnitude and a place, a departure time and a gate -- and the only
      // honest way to carry those is to carry the row.
      text: redact(text).slice(0, 300),
      lines: lines.slice(0, 6).map((ln) => redact(ln).slice(0, 120)),
      // The row's first number, whatever it means here.
      number: numberMatch ? Number(numberMatch[0]) : null,
      rating: ratingMatch ? Number(ratingMatch[1]) : null,
      url: url,
      url_live: url !== '',
    }
    if (priceMatch && priceInt !== null) {
      item.price_int = priceInt
      item.price_text = priceMatch[0]
    }
    items.push(item)
  }

  if (params.text_contains) {
    const needle = String(params.text_contains).toLowerCase()
    return {
      items: items.filter((i) => (i.name + ' ' + i.text).toLowerCase().indexOf(needle) !== -1),
      group_size: best.list.length,
      filtered_by: params.text_contains,
    }
  }
  return { items: items, group_size: best.list.length, priced: requirePrice }
}

/**
 * A cheap fingerprint of the page, for judging an action whose effect cannot
 * be read back directly -- anything drawn to a canvas, above all.
 *
 * None of these parts is interesting alone. Together they move whenever an
 * application actually does something: it enables toolbar controls, moves a
 * selection, updates a status line, redraws a formula bar.
 */
function domSignature() {
  const body = document.body
  const active = document.activeElement
  return [
    document.querySelectorAll('*').length,
    document.querySelectorAll('[aria-disabled="true"]').length,
    document.querySelectorAll('[aria-selected="true"]').length,
    document.querySelectorAll('[role="status"], [role="alert"]').length,
    body ? (body.innerText || '').length : 0,
    active ? String(active.value || active.textContent || '').length : 0,
  ].join('|')
}

/**
 * Everything on the page a person could actually read, including the places a
 * canvas application keeps its current value: the formula bar, a focused
 * editor, the off-screen layer it maintains for screen readers. innerText
 * alone misses all of those, which is why a landed paste looked like nothing.
 */
function readableText() {
  const parts = []
  // textContent, NOT innerText. innerText returns only what is RENDERED, and a
  // canvas application keeps its text in an off-screen layer for screen
  // readers -- exactly the place worth looking. Using innerText here is why a
  // paste whose cells were plainly in the sheet came back undetected.
  if (document.body) parts.push(document.body.textContent || '')
  document.querySelectorAll('input, textarea').forEach((el) => {
    if (el.value) parts.push(String(el.value))
  })
  // Editors that hold their value in an attribute rather than a text node.
  // Their text is already in body.textContent above; this is for the label.
  document.querySelectorAll('[aria-label]').forEach((el) => {
    const label = el.getAttribute('aria-label')
    if (label) parts.push(label)
  })
  return parts.join('\n')
}

function escapeHtmlCell(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Put a whole table into a spreadsheet in one action.
 *
 * A spreadsheet grid is a <canvas>. There are no cell elements to resolve, to
 * click or to type into, so the walker cannot see the grid and `type` has
 * nothing to aim at. What a grid DOES have is a paste handler, because pasting
 * a block of cells is the ordinary way people move a table into one -- and a
 * paste carries the whole table's shape in a single event, so the row and
 * column structure is the spreadsheet's problem rather than ours.
 *
 * Both flavours go on the clipboard payload. Sheets reads text/html first and
 * gets cleaner cell boundaries from it; text/plain TSV is the fallback every
 * grid understands, and is what a plain textarea would receive.
 *
 * HOW THIS IS VERIFIED, and how it was verified wrongly at first.
 *
 * The first version treated preventDefault as the whole answer: a grid that
 * takes a paste cancels the event, so `dispatchEvent` returning false meant
 * success. It is sound evidence when it happens -- and Google Sheets does not
 * do it. The cells landed correctly on the very first attempt and this
 * function reported failure, so the agent pasted the same table another five
 * times. A verification signal that is merely SUFFICIENT must never be used as
 * though it were NECESSARY.
 *
 * The replacement for that was a generic page fingerprint, and it was still
 * too weak: on Sheets nothing it counted moved, so a landed paste was reported
 * as a failure a second time. The signal that actually works is the direct
 * one. A grid that takes cells has to show the active cell's value SOMEWHERE
 * a person can read it -- the formula bar, the accessibility layer -- and that
 * somewhere is ordinary DOM. So probe for the pasted header text itself:
 * absent from the page before, present after, means the cells went in.
 *
 * The fingerprint is kept as a weaker third signal for grids that put nothing
 * readable on screen.
 *
 * Candidates are also tried ONE AT A TIME now, each judged before moving on.
 * Dispatching at all of them up front was how one requested paste could become
 * three pastes on a page that handles the event at the document level.
 */
async function doPasteTable(params) {
  const tsv = String(params.text == null ? '' : params.text).replace(/\r\n/g, '\n')
  if (!tsv.trim()) return { handled: false, error: 'paste_table needs tab-separated text' }

  const rows = tsv.split('\n').map((r) => r.split('\t'))
  // The first row goes in as <th>. A grid that reads the HTML flavour renders
  // those bold, so "make it a proper table" costs nothing extra and the header
  // is distinguishable from the data without a second formatting pass.
  const html = '<meta charset="utf-8"><table>' + rows.map((cells, i) => {
    const tag = (i === 0 && params.header !== false) ? 'th' : 'td'
    return '<tr>' + cells.map(
      (c) => '<' + tag + '>' + escapeHtmlCell(c) + '</' + tag + '>',
    ).join('') + '</tr>'
  }).join('') + '</table>'

  // Whatever holds focus after the agent selected a cell. The event bubbles
  // and is composed, so a listener anywhere above it still sees the paste.
  const candidates = []
  const active = document.activeElement
  if (active && active !== document.body) candidates.push(active)
  const editor = document.querySelector('[contenteditable="true"], textarea')
  if (editor && candidates.indexOf(editor) === -1) candidates.push(editor)
  if (document.body) candidates.push(document.body)

  // A distinctive cell to look for afterwards. The longest one in the first
  // row: a header like "Magnitude" is far less likely to already be somewhere
  // on the page than a bare number would be.
  const probe = (rows[0] || [])
    .map((c) => String(c || '').trim())
    .filter((c) => c.length >= 4)
    .sort((a, b) => b.length - a.length)[0] || ''

  const attempts = []
  for (const node of candidates) {
    let dt
    try {
      dt = new DataTransfer()
      dt.setData('text/plain', tsv)
      dt.setData('text/html', html)
    } catch (e) {
      return { dispatched: false, error: 'DataTransfer unavailable: ' + e.message }
    }
    const where = node.tagName ? node.tagName.toLowerCase() : 'unknown'
    const beforeSig = domSignature()
    // Only a probe the page does NOT already contain can prove anything.
    const probeUsable = probe !== '' && readableText().indexOf(probe) === -1

    const ev = new ClipboardEvent('paste', {
      clipboardData: dt, bubbles: true, cancelable: true, composed: true,
    })
    const uncancelled = node.dispatchEvent(ev)
    // Grids apply a paste asynchronously; asking immediately reads the page as
    // it was before it had any chance to react.
    await sleep(700)

    const prevented = !uncancelled
    const probeFound = probeUsable && readableText().indexOf(probe) !== -1
    const changed = domSignature() !== beforeSig
    attempts.push({
      on: where, default_prevented: prevented,
      probe_found: probeFound, page_changed: changed,
    })

    if (prevented || probeFound || changed) {
      return {
        dispatched: true,
        default_prevented: prevented,
        probe_found: probeFound,
        // Always reported, found or not, so the server can look for it too in
        // the fresh observation it takes next -- an independent check through
        // the walker rather than through this function's own idea of what is
        // readable.
        probe: probe.slice(0, 60),
        page_changed: changed,
        strategy: 'clipboard-paste',
        dispatched_on: where,
        rows: rows.length,
        columns: rows[0] ? rows[0].length : 0,
        attempts: attempts,
      }
    }
  }

  return {
    dispatched: attempts.length > 0,
    default_prevented: false,
    probe_found: false,
    probe: probe.slice(0, 60),
    page_changed: false,
    error: 'the paste left the page completely unchanged, so nothing took it',
    attempts: attempts,
    rows: rows.length,
    columns: rows[0] ? rows[0].length : 0,
  }
}

async function doWait(params) {
  const timeout = Math.min(Number(params.timeout_ms) || 5000, 60000)
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
      await sleep(150)
      return { ok: true, result: Object.assign({ resolution: how, before: before }, r) }
    }
    case 'type': {
      const r = await doType(el, String(params.text == null ? '' : params.text), params.replace)
      return { ok: r.typed, result: Object.assign({ resolution: how }, r), error: r.typed ? undefined : r.error }
    }
    case 'keypress': {
      const r = await doKeypress(el, params.key_combo)
      await sleep(150)
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
        return {
          ok: false,
          error: 'target is not a <select> (it is a <' + el.tagName.toLowerCase() + '>'
            + (el.getAttribute('role') ? ' with role="' + el.getAttribute('role') + '"' : '')
            + '); this is a custom dropdown, not a native one -- click it to open the '
            + 'menu, then click the option that appears instead of using select',
        }
      }
      const want = String(params.value == null ? '' : params.value)
      const opt = Array.from(el.options).find((o) => o.value === want || (o.textContent || '').trim() === want)
      if (!opt) {
        const available = Array.from(el.options).map((o) => (o.textContent || '').trim()).filter(Boolean).slice(0, 20)
        return { ok: false, error: 'option not found: ' + want + (available.length ? '; available options: ' + available.join(', ') : '') }
      }
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
    case 'paste_table': {
      const r = await doPasteTable(params)
      const landed = !!(r.default_prevented || r.probe_found || r.page_changed)
      return { ok: landed, result: r, error: landed ? undefined : r.error }
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
    showScanOverlay()
    Promise.resolve()
      .then(async () => {
        const started = Date.now()
        privacyMode = message.privacy_mode || 'balanced'
        keepTerms = (message.keep_terms || []).map((t) => String(t).toLowerCase())
        const observation = walk()
        const remaining = 700 - (Date.now() - started)
        if (remaining > 0) await sleep(remaining)
        return { ok: true, observation }
      })
      .catch((e) => ({ ok: false, error: 'walk failed: ' + e.message }))
      .finally(() => hideScanOverlay())
      .then((reply) => sendResponse(reply))
    return true
  }

  if (message.type === 'AGENT_FETCH_DOCUMENT') {
    // Fetch the document's raw bytes FROM THE PAGE, so the request carries the
    // user's own cookies and session. A PDF behind a login is the normal case
    // for a college portal, and fetching it server-side would just get the
    // sign-in page back.
    fetchDocumentBytes(message.url || location.href)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }))
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
