// NetraShield Content Script (Manifest V3)
// Performs on-device zero-leak DOM inspection, regex PII detection, visual masking, and command execution.

(() => {
  let maskContainer = null
  let activeHighlight = null
  let elementIdCounter = 0

  // Regex patterns for sensitive Indian & global PII
  const PATTERNS = {
    card: /\b(?:\d[ -]*?){13,19}\b/g,
    aadhaar: /\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b(?!\s?\d)/g,
    pan: /\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/g,
    voterId: /\b[A-Z]{3}[0-9]{7}\b/g,
    drivingLicense: /\b[A-Z]{2}[0-9]{2}[ -]?(?:19|20)[0-9]{2}[0-9]{7}\b|\b[A-Z]{2}[ -]?[0-9]{13,15}\b/g,
    gstin: /\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}\b/g,
    email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    phone: /\b(?:\+91[\s-]?)?[6-9]\d{9}\b/g,
    currency: /(?:₹|Rs\.?|INR|\$|€|£)\s?[\d,]+(?:\.\d{2})?\b/gi,
  }

  function getOrAssignId(element) {
    if (element.id && element.id.trim()) {
      return element.id.trim()
    }
    let assigned = element.getAttribute('data-netrashield-id')
    if (!assigned) {
      assigned = `ns-${++elementIdCounter}`
      element.setAttribute('data-netrashield-id', assigned)
    }
    return assigned
  }

  function findElementByIdOrNs(id) {
    if (!id) return null
    return document.getElementById(id) || document.querySelector(`[data-netrashield-id="${id}"]`)
  }

  function sanitizeText(rawText) {
    let sanitized = rawText
    let count = 0
    const matchedTypes = []

    if (PATTERNS.currency.test(sanitized)) {
      sanitized = sanitized.replace(PATTERNS.currency, '[REDACTED_AMOUNT]')
      matchedTypes.push('Financial')
      count++
    }
    if (PATTERNS.drivingLicense.test(sanitized)) {
      sanitized = sanitized.replace(PATTERNS.drivingLicense, '[REDACTED_DRIVING_LICENSE]')
      matchedTypes.push('Driving License')
      count++
    }
    if (PATTERNS.gstin.test(sanitized)) {
      sanitized = sanitized.replace(PATTERNS.gstin, '[REDACTED_GSTIN]')
      matchedTypes.push('GSTIN')
      count++
    }
    if (PATTERNS.voterId.test(sanitized)) {
      sanitized = sanitized.replace(PATTERNS.voterId, '[REDACTED_VOTER_ID]')
      matchedTypes.push('Voter ID')
      count++
    }
    if (PATTERNS.pan.test(sanitized)) {
      sanitized = sanitized.replace(PATTERNS.pan, '[REDACTED_PAN]')
      matchedTypes.push('PAN')
      count++
    }
    if (PATTERNS.card.test(sanitized)) {
      sanitized = sanitized.replace(PATTERNS.card, '[REDACTED_CARD]')
      matchedTypes.push('Card')
      count++
    }
    if (PATTERNS.aadhaar.test(sanitized)) {
      sanitized = sanitized.replace(PATTERNS.aadhaar, '[REDACTED_AADHAAR]')
      matchedTypes.push('Aadhaar')
      count++
    }
    if (PATTERNS.email.test(sanitized)) {
      sanitized = sanitized.replace(PATTERNS.email, '[REDACTED_EMAIL]')
      matchedTypes.push('Email')
      count++
    }
    if (PATTERNS.phone.test(sanitized)) {
      sanitized = sanitized.replace(PATTERNS.phone, '[REDACTED_PHONE]')
      matchedTypes.push('Phone')
      count++
    }

    return { sanitized, count, matchedTypes }
  }

  function scanDOM(privacyMode = 'strict') {
    const startTime = performance.now()
    const regions = []
    const elements = []
    const redactionCounts = {}
    let redactionCounter = 0
    let buttonCount = 0
    let inputCount = 0
    let linkCount = 0

    const candidates = document.querySelectorAll(
      'input, button, textarea, select, a, [role="button"], form, p, span, h1, h2, h3, div[class*="price"], div[class*="total"]'
    )

    const domMs = Math.round(performance.now() - startTime)
    const redactionStart = performance.now()

    candidates.forEach((node) => {
      const rect = node.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0 || window.getComputedStyle(node).display === 'none') {
        return
      }

      const id = getOrAssignId(node)
      const tagName = node.tagName.toLowerCase()
      const role = node.getAttribute('role') || (tagName === 'a' ? 'link' : tagName === 'button' ? 'button' : tagName === 'input' ? 'input' : 'generic')
      
      let rawText = ''
      let isSensitiveInput = false
      let sensitiveReason = ''

      if (tagName === 'input') {
        inputCount++
        const inputType = (node.getAttribute('type') || 'text').toLowerCase()
        const nameAttr = (node.getAttribute('name') || '').toLowerCase()
        const idAttr = (node.id || '').toLowerCase()
        const placeholder = node.getAttribute('placeholder') || ''

        rawText = node.value || placeholder || ''

        if (inputType === 'password' || nameAttr.includes('pass') || idAttr.includes('pass')) {
          isSensitiveInput = true
          sensitiveReason = 'Password'
        } else if (nameAttr.includes('cvv') || nameAttr.includes('pin') || idAttr.includes('cvv')) {
          isSensitiveInput = true
          sensitiveReason = 'CVV/PIN'
        } else if (nameAttr.includes('card') || nameAttr.includes('account')) {
          isSensitiveInput = true
          sensitiveReason = 'Card/Account'
        } else if (nameAttr.includes('aadhaar') || idAttr.includes('aadhaar') || placeholder.toLowerCase().includes('aadhaar')) {
          isSensitiveInput = true
          sensitiveReason = 'Aadhaar'
        } else if (nameAttr.includes('pan') || idAttr.includes('pan') || placeholder.toLowerCase().includes('pan')) {
          isSensitiveInput = true
          sensitiveReason = 'PAN'
        } else if (nameAttr.includes('voter') || idAttr.includes('voter') || nameAttr.includes('epic') || placeholder.toLowerCase().includes('voter')) {
          isSensitiveInput = true
          sensitiveReason = 'Voter ID'
        } else if (nameAttr.includes('dl') || nameAttr.includes('driving') || nameAttr.includes('license') || idAttr.includes('license')) {
          isSensitiveInput = true
          sensitiveReason = 'Driving License'
        } else if (nameAttr.includes('gstin') || idAttr.includes('gstin') || nameAttr.includes('tax') || placeholder.toLowerCase().includes('gstin')) {
          isSensitiveInput = true
          sensitiveReason = 'GSTIN'
        }
      } else {
        if (tagName === 'button' || role === 'button') buttonCount++
        if (tagName === 'a' || role === 'link') linkCount++
        rawText = (node.innerText || node.textContent || '').trim()
      }

      const { sanitized, count, matchedTypes } = sanitizeText(rawText)

      const boxTuple = [
        Math.round(rect.top + window.scrollY),
        Math.round(rect.left + window.scrollX),
        Math.round(rect.width),
        Math.round(rect.height),
      ]

      if (isSensitiveInput || count > 0) {
        const label = sensitiveReason || matchedTypes.join(', ') || 'Sensitive Data'
        const regionType = isSensitiveInput ? 'input' : 'text'
        redactionCounter++
        redactionCounts[label] = (redactionCounts[label] || 0) + 1

        regions.push({
          id: `reg-${redactionCounter}`,
          label,
          type: regionType,
          confidence: 0.95,
          source: 'dom-scanner',
          box: boxTuple,
        })
      }

      if (
        tagName === 'button' ||
        tagName === 'input' ||
        tagName === 'select' ||
        role === 'button' ||
        role === 'link' ||
        node.hasAttribute('onclick')
      ) {
        const cleanLabel = isSensitiveInput ? '[PROTECTED INPUT]' : sanitized.slice(0, 80)
        elements.push({
          id,
          role,
          label: cleanLabel,
          box: boxTuple,
          masked: isSensitiveInput || count > 0,
        })
      }
    })

    const totalMs = Math.round(performance.now() - startTime)
    const redactionMs = Math.round(performance.now() - redactionStart)

    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .map((el) => (el.innerText || el.textContent || '').trim())
      .filter(Boolean)
      .slice(0, 8)
    const paragraphs = Array.from(document.querySelectorAll('main p, article p, p, li, [class*="content"]'))
      .map((el) => (el.innerText || el.textContent || '').trim())
      .filter((t) => t.length > 15 && t.length < 500)
      .slice(0, 15)
    let extractedText = ''
    if (headings.length > 0) extractedText += `Headings: ${headings.join(' | ')}\n`
    if (paragraphs.length > 0) extractedText += `Key Content: ${paragraphs.join(' ')}\n`
    const { sanitized: pageText } = sanitizeText(extractedText.slice(0, 3000))

    const payload = {
      schemaVersion: '1.0.0',
      mode: privacyMode,
      page: {
        origin: window.location.origin || 'about:blank',
        titleHint: document.title || 'Untitled Page',
      },
      privacySummary: {
        regionCount: regions.length,
        redactionTypes: redactionCounts,
        coverage: regions.length > 0 ? 1 : 0,
      },
      pageText,
      elements: elements.slice(0, 40),
      redactions: regions.map((r) => ({
        id: r.id,
        type: r.type,
        confidence: r.confidence,
        box: r.box,
      })),
      visualSummary: {
        visualDensity: 'compact',
        model: 'netrashield-rules-v1',
        elementCounts: {
          buttons: buttonCount,
          fields: inputCount,
          links: linkCount,
          total: buttonCount + inputCount + linkCount,
        },
      },
    }

    return {
      url: window.location.href,
      title: document.title || 'Untitled Page',
      regions,
      elements: elements.slice(0, 40),
      payload,
      timings: {
        domMs,
        redactionMs,
        totalMs,
      },
    }
  }

  function applyMasks(regions, mode = 'strict') {
    clearMasks()
    if (mode === 'fast' || !regions || regions.length === 0) return ''

    maskContainer = document.createElement('div')
    maskContainer.id = 'netrashield-mask-root'
    maskContainer.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 2147483640;
    `

    regions.forEach((region, index) => {
      const maskEl = document.createElement('div')
      const isStrict = mode === 'strict'
      const [top, left, width, height] = region.box

      maskEl.style.cssText = `
        position: absolute;
        top: ${top}px;
        left: ${left}px;
        width: ${width}px;
        height: ${height}px;
        background: ${isStrict ? 'rgba(8, 14, 22, 0.94)' : 'rgba(2, 6, 23, 0.75)'};
        backdrop-filter: blur(8px);
        border: 1.5px solid #10b981;
        border-radius: 4px;
        box-shadow: 0 0 12px rgba(16, 185, 129, 0.4);
        display: flex;
        align-items: center;
        justify-content: flex-start;
        padding: 0 4px;
        color: #34d399;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.5px;
        text-transform: uppercase;
        overflow: hidden;
        animation: ns-pop 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;
        animation-delay: ${index * 40}ms;
      `
      maskEl.innerText = `🔒 ${region.label || region.type || 'REDACTED'}`
      maskContainer.appendChild(maskEl)
    })

    document.body.appendChild(maskContainer)

    try {
      const canvas = document.createElement('canvas')
      canvas.width = 480
      canvas.height = 300
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.fillStyle = '#0f172a'
        ctx.fillRect(0, 0, 480, 300)
        ctx.fillStyle = '#34d399'
        ctx.font = 'bold 11px sans-serif'
        ctx.fillText(`🛡️ NetraShield Active: ${regions.length} PII Masked`, 14, 285)
        return canvas.toDataURL('image/png')
      }
    } catch {
      // fallback
    }
    return ''
  }

  function clearMasks() {
    const existing = document.getElementById('netrashield-mask-root')
    if (existing) {
      existing.remove()
    }
    maskContainer = null
  }

  function executeCommand(command) {
    if (activeHighlight) {
      activeHighlight.remove()
      activeHighlight = null
    }

    if (command.type !== 'highlight' || !command.targetId) return

    const target = findElementByIdOrNs(command.targetId)
    if (!target) {
      console.warn('[NetraShield] Target element not found:', command.targetId)
      return
    }

    target.scrollIntoView({ behavior: 'smooth', block: 'center' })

    const rect = target.getBoundingClientRect()
    const highlight = document.createElement('div')
    highlight.id = 'netrashield-active-target'
    highlight.style.cssText = `
      position: absolute;
      top: ${rect.top + window.scrollY - 4}px;
      left: ${rect.left + window.scrollX - 4}px;
      width: ${rect.width + 8}px;
      height: ${rect.height + 8}px;
      border: 3px solid #10b981;
      border-radius: 8px;
      box-shadow: 0 0 20px rgba(16, 185, 129, 0.6);
      pointer-events: none;
      z-index: 2147483645;
      animation: ns-pulse 1.5s infinite;
    `

    const badge = document.createElement('div')
    badge.style.cssText = `
      position: absolute;
      top: -28px;
      left: 0;
      background: #10b981;
      color: #000;
      font-family: system-ui, sans-serif;
      font-size: 11px;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 4px;
      white-space: nowrap;
      box-shadow: 0 2px 6px rgba(0,0,0,0.4);
    `
    badge.innerText = '⚡ NetraShield Target'
    highlight.appendChild(badge)

    if (!document.getElementById('ns-styles')) {
      const style = document.createElement('style')
      style.id = 'ns-styles'
      style.textContent = `
        @keyframes ns-pulse {
          0% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.02); opacity: 0.8; }
          100% { transform: scale(1); opacity: 1; }
        }
      `
      document.head.appendChild(style)
    }

    document.body.appendChild(highlight)
    activeHighlight = highlight
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      try {
        switch (message.type) {
          case 'NETRASHIELD_AUTO_SCROLL_SCAN':
          case 'NETRASHIELD_SCAN': {
            const scanData = scanDOM(message.mode)
            sendResponse(scanData)
            break
          }
          case 'NETRASHIELD_APPLY_MASKS': {
            const scanData = scanDOM(message.mode)
            const screenshot = applyMasks(scanData.regions, message.mode)
            sendResponse({ ok: true, screenshot, count: scanData.regions.length })
            break
          }
          case 'NETRASHIELD_CLEAR_MASKS': {
            clearMasks()
            sendResponse({ ok: true })
            break
          }
          case 'NETRASHIELD_EXECUTE_COMMAND': {
            executeCommand(message.command)
            sendResponse({ ok: true })
            break
          }
          default:
            sendResponse({ ok: false, error: 'Unknown message type' })
        }
      } catch (err) {
        console.error('[NetraShield Content Script Error]:', err)
        sendResponse({ ok: false, error: err.message })
      }
      return true
    })
  }
})()
