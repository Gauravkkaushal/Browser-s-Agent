const NETRASHIELD_MASK_LAYER = 'netrashield-mask-layer'
const NETRASHIELD_HIGHLIGHT = 'netrashield-action-highlight'

const sensitiveKeywords = [
  'aadhaar',
  'account',
  'address',
  'card',
  'cvv',
  'dob',
  'email',
  'mobile',
  'name',
  'otp',
  'pan',
  'passport',
  'password',
  'phone',
  'pin',
  'upi',
]

const patterns = [
  { type: 'Email', regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { type: 'Phone', regex: /\b(?:\+91[-\s]?)?[6-9]\d{9}\b/ },
  { type: 'Payment card', regex: /\b(?:\d[ -]*?){13,19}\b/ },
  { type: 'UPI ID', regex: /\b[\w.-]+@(?:upi|oksbi|okhdfcbank|okaxis|paytm|ibl|ybl)\b/i },
  { type: 'PAN', regex: /\b[A-Z]{5}\d{4}[A-Z]\b/ },
  { type: 'Aadhaar-like ID', regex: /\b\d{4}\s?\d{4}\s?\d{4}\b/ },
  { type: 'Date of birth', regex: /\b(?:dob|birth|date of birth)[:\s-]*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/i },
]

let lastScan = null

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'NETRASHIELD_SCAN') {
    lastScan = scanPage(message.mode)
    sendResponse(lastScan)
    return true
  }

  if (message.type === 'NETRASHIELD_APPLY_MASKS') {
    if (!lastScan) {
      lastScan = scanPage(message.mode)
    }

    applyMasks(lastScan.regions)
    sendResponse({ ok: true })
    return true
  }

  if (message.type === 'NETRASHIELD_CLEAR_MASKS') {
    clearMasks()
    sendResponse({ ok: true })
    return true
  }

  if (message.type === 'NETRASHIELD_EXECUTE_COMMAND') {
    if (!lastScan) {
      lastScan = scanPage(message.mode)
    }

    executeCommand(message.command, lastScan.elements)
    sendResponse({ ok: true })
    return true
  }

  return false
})

function scanPage(mode = 'balanced') {
  const started = performance.now()
  const rawElements = collectPageElements()
  const regions = collectSensitiveRegions(rawElements, mode)
  const elements = rawElements.map((element) => toServerSafeElement(element, regions))
  const visualSummary = buildLocalVisualSummary(rawElements, regions)
  const afterDom = performance.now()
  const payload = buildSanitizedPayload(elements, regions, visualSummary, mode)

  return {
    url: location.href,
    title: document.title || location.hostname,
    regions,
    elements,
    payload,
    visualSummary,
    timings: {
      domMs: Math.round(afterDom - started),
      redactionMs: Math.max(6, Math.round(regions.length * (mode === 'strict' ? 6 : mode === 'balanced' ? 4 : 2))),
      totalMs: Math.round(performance.now() - started),
    },
  }
}

function collectPageElements() {
  const selector = [
    'a',
    'button',
    'input',
    'textarea',
    'select',
    '[role]',
    '[contenteditable="true"]',
  ].join(',')

  return Array.from(document.querySelectorAll(selector))
    .filter(isVisible)
    .slice(0, 160)
    .map((element, index) => {
      element.dataset.netrashieldId = element.dataset.netrashieldId || `ns_el_${index}_${Date.now()}`
      const rect = element.getBoundingClientRect()
      const label = getNearbyLabel(element)
      const rawText = getElementText(element)

      return {
        id: element.dataset.netrashieldId,
        originalId: element.getAttribute('id') || '',
        name: element.getAttribute('name') || '',
        placeholder: element.getAttribute('placeholder') || '',
        ariaLabel: element.getAttribute('aria-label') || '',
        autocomplete: element.getAttribute('autocomplete') || '',
        label,
        role: getRole(element),
        rawText,
        tag: element.tagName.toLowerCase(),
        inputType: element.getAttribute('type') || '',
        isEditable: isEditableElement(element),
        box: toBox(rect),
      }
    })
}

function collectSensitiveRegions(elements, mode) {
  const regions = []

  elements.forEach((element) => {
    const sensitivity = getElementSensitivity(element, mode)

    if (!sensitivity) {
      return
    }

    regions.push({
      id: `region_${regions.length + 1}`,
      label: sensitivity.label,
      type: sensitivity.type,
      confidence: sensitivity.confidence,
      source: sensitivity.source,
      box: element.box,
    })
  })

  if (mode !== 'fast') {
    collectSensitiveTextBlocks(regions)
  }

  return dedupeRegions(regions).slice(0, mode === 'strict' ? 90 : mode === 'balanced' ? 60 : 35)
}

function collectSensitiveTextBlocks(regions) {
  const blocks = Array.from(document.querySelectorAll('p, span, strong, b, td, th, li, label, div'))
    .filter(isVisible)
    .filter((element) => element.children.length <= 3)
    .slice(0, 260)

  blocks.forEach((element) => {
    const text = normalizeText(element.innerText || element.textContent || '')

    if (!text || text.length > 220 || !containsPattern(text)) {
      return
    }

    regions.push({
      id: `region_${regions.length + 1}`,
      label: guessPatternType(text),
      type: 'Visible text PII',
      confidence: 0.88,
      source: 'regex-text',
      box: toBox(element.getBoundingClientRect()),
    })
  })
}

function getElementSensitivity(element, mode) {
  const haystack = normalizeText(
    [
      element.rawText,
      element.inputType,
      element.tag,
      element.originalId,
      element.name,
      element.placeholder,
      element.ariaLabel,
      element.autocomplete,
      element.label,
    ].join(' '),
  ).toLowerCase()

  const keyword = sensitiveKeywords.find((item) => haystack.includes(item))
  const patternType = guessPatternType(element.rawText)

  if (element.inputType === 'password') {
    return { label: 'Password field', type: 'Password', confidence: 0.99, source: 'dom-type' }
  }

  if (patternType) {
    return { label: patternType, type: patternType, confidence: 0.95, source: 'regex-element' }
  }

  if (keyword) {
    return {
      label: `${capitalize(keyword)} field`,
      type: keyword === 'name' ? 'Name' : 'Sensitive field',
      confidence: mode === 'strict' ? 0.9 : 0.84,
      source: 'semantic-dom',
    }
  }

  return null
}

function buildLocalVisualSummary(elements, regions) {
  const viewport = {
    width: window.innerWidth,
    height: window.innerHeight,
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
  }
  const buttons = elements.filter((element) => element.role === 'button').length
  const fields = elements.filter((element) => element.role === 'field').length
  const links = elements.filter((element) => element.role === 'link').length

  return {
    viewport,
    elementCounts: { buttons, fields, links, total: elements.length },
    visualDensity: classifyDensity(elements.length),
    redactionCoverage: estimateRedactionCoverage(regions, viewport),
    model: 'NetraShield local perception v0.1: DOM geometry + regex PII + semantic field detector',
  }
}

function buildSanitizedPayload(elements, regions, visualSummary, mode) {
  return {
    schemaVersion: 'netrashield.sanitized.v1',
    mode,
    page: {
      origin: location.origin,
      titleHint: sanitizeTitle(document.title || location.hostname),
    },
    privacySummary: {
      regionCount: regions.length,
      redactionTypes: summarizeRedactionTypes(regions),
      coverage: visualSummary.redactionCoverage,
    },
    visualSummary,
    redactions: regions.map((region) => ({
      id: region.id,
      type: region.type,
      confidence: region.confidence,
      box: region.box,
    })),
    elements: elements.map(({ id, role, label, box, masked }) => ({ id, role, label, box, masked })),
  }
}

function toServerSafeElement(element, regions) {
  const masked = regions.some((region) => overlaps(region.box, element.box))

  return {
    id: element.id,
    role: element.role,
    label: masked ? `[MASKED_${element.role.toUpperCase()}]` : safeLabel(element),
    box: element.box,
    masked,
  }
}

function applyMasks(regions) {
  clearMasks()

  const layer = document.createElement('div')
  layer.id = NETRASHIELD_MASK_LAYER
  layer.style.position = 'absolute'
  layer.style.inset = '0'
  layer.style.zIndex = '2147483646'
  layer.style.pointerEvents = 'none'

  regions.forEach((region) => {
    const [x, y, width, height] = region.box
    const mask = document.createElement('div')
    mask.title = `NetraShield masked ${region.type}`
    mask.style.position = 'absolute'
    mask.style.left = `${x}px`
    mask.style.top = `${y}px`
    mask.style.width = `${Math.max(width, 12)}px`
    mask.style.height = `${Math.max(height, 12)}px`
    mask.style.borderRadius = '4px'
    mask.style.background = 'rgba(8, 14, 18, 0.94)'
    mask.style.outline = '2px solid rgba(15, 118, 110, 0.9)'
    mask.style.backdropFilter = 'blur(8px)'
    layer.appendChild(mask)
  })

  document.documentElement.appendChild(layer)
}

function clearMasks() {
  document.getElementById(NETRASHIELD_MASK_LAYER)?.remove()
  document.getElementById(NETRASHIELD_HIGHLIGHT)?.remove()
}

function executeCommand(command, elements) {
  document.getElementById(NETRASHIELD_HIGHLIGHT)?.remove()

  if (!command || command.type === 'none') {
    return
  }

  const target = elements.find((element) => element.id === command.targetId) || findLikelyAction(elements)

  if (!target) {
    return
  }

  highlightBox(target.box, command.instruction || 'Suggested action')
}

function findLikelyAction(elements) {
  return elements.find((element) => {
    const text = normalizeText(`${element.role} ${element.label}`).toLowerCase()
    return element.role === 'button' && /(submit|continue|next|review|pay|send|save|login|sign in)/.test(text)
  })
}

function highlightBox(box, instruction) {
  const [x, y, width, height] = box
  const highlight = document.createElement('div')
  highlight.id = NETRASHIELD_HIGHLIGHT
  highlight.style.position = 'absolute'
  highlight.style.left = `${x - 4}px`
  highlight.style.top = `${y - 4}px`
  highlight.style.width = `${width + 8}px`
  highlight.style.height = `${height + 8}px`
  highlight.style.border = '3px solid #0f766e'
  highlight.style.borderRadius = '8px'
  highlight.style.boxShadow = '0 0 0 99999px rgba(17, 24, 39, 0.12)'
  highlight.style.zIndex = '2147483647'
  highlight.style.pointerEvents = 'none'
  highlight.title = instruction
  document.documentElement.appendChild(highlight)
}

function getRole(element) {
  if (element.getAttribute('role')) {
    return element.getAttribute('role')
  }

  const tag = element.tagName.toLowerCase()

  if (tag === 'button') {
    return 'button'
  }

  if (tag === 'a') {
    return 'link'
  }

  if (['input', 'textarea', 'select'].includes(tag)) {
    return 'field'
  }

  return tag
}

function getElementText(element) {
  const label = getNearbyLabel(element)
  const text = [
    label,
    element.getAttribute('aria-label'),
    element.getAttribute('placeholder'),
    element.getAttribute('name'),
    element.getAttribute('id'),
    element.innerText,
    element.value,
  ]
    .filter(Boolean)
    .join(' ')

  return normalizeText(text)
}

function getNearbyLabel(element) {
  if (element.id) {
    const explicit = document.querySelector(`label[for="${CSS.escape(element.id)}"]`)

    if (explicit?.textContent) {
      return explicit.textContent
    }
  }

  const parentLabel = element.closest('label')

  if (parentLabel?.textContent) {
    return parentLabel.textContent
  }

  return ''
}

function safeLabel(element) {
  const raw = normalizeText(element.rawText || element.ariaLabel || element.placeholder || element.name || element.role)

  if (!raw || containsPattern(raw)) {
    return element.role
  }

  return raw
    .replace(/\b\d{2,}\b/g, '[NUMBER]')
    .replace(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g, '[NAME]')
    .slice(0, 64)
}

function sanitizeTitle(title) {
  return sanitizeText(title).slice(0, 80)
}

function sanitizeText(text) {
  let output = normalizeText(text)

  patterns.forEach((pattern) => {
    output = output.replace(pattern.regex, `[REDACTED_${pattern.type.toUpperCase().replaceAll(' ', '_')}]`)
  })

  return output
}

function containsPattern(text) {
  return patterns.some((pattern) => pattern.regex.test(text))
}

function guessPatternType(text = '') {
  const match = patterns.find((pattern) => pattern.regex.test(text))
  return match?.type || ''
}

function summarizeRedactionTypes(regions) {
  return regions.reduce((summary, region) => {
    summary[region.type] = (summary[region.type] || 0) + 1
    return summary
  }, {})
}

function estimateRedactionCoverage(regions, viewport) {
  const viewportArea = Math.max(1, viewport.width * viewport.height)
  const regionArea = regions.reduce((sum, region) => sum + region.box[2] * region.box[3], 0)
  return Math.min(100, Math.round((regionArea / viewportArea) * 1000) / 10)
}

function classifyDensity(count) {
  if (count > 90) {
    return 'dense'
  }

  if (count > 35) {
    return 'moderate'
  }

  return 'simple'
}

function dedupeRegions(regions) {
  return regions.filter((region, index) => {
    return !regions.some((candidate, candidateIndex) => candidateIndex < index && overlaps(candidate.box, region.box))
  })
}

function overlaps(a, b) {
  const [ax, ay, aw, ah] = a
  const [bx, by, bw, bh] = b

  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by
}

function isEditableElement(element) {
  const tag = element.tagName.toLowerCase()
  return ['input', 'textarea', 'select'].includes(tag) || element.getAttribute('contenteditable') === 'true'
}

function isVisible(element) {
  const rect = element.getBoundingClientRect()
  const style = window.getComputedStyle(element)

  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.visibility !== 'hidden' &&
    style.display !== 'none' &&
    Number(style.opacity) !== 0
  )
}

function toBox(rect) {
  return [
    Math.round(rect.left + window.scrollX),
    Math.round(rect.top + window.scrollY),
    Math.round(rect.width),
    Math.round(rect.height),
  ]
}

function normalizeText(text) {
  return String(text).replace(/\s+/g, ' ').trim()
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
