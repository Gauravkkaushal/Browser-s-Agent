const DEFAULT_SERVER_URL = 'http://localhost:8787/reason'

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'NETRASHIELD_REASON') {
    return false
  }

  reasonOverSanitizedContext(message.payload)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        source: 'extension-fallback',
        error: error instanceof Error ? error.message : 'Reasoning failed',
        command: buildFallbackCommand(message.payload),
      })
    })

  return true
})

async function reasonOverSanitizedContext(payload) {
  const { serverUrl = DEFAULT_SERVER_URL } = await chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER_URL })

  const response = await fetch(serverUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(`Server returned ${response.status}`)
  }

  const data = await response.json()

  return {
    ok: true,
    source: 'server',
    command: data.command || buildFallbackCommand(payload),
    rationale: data.rationale || 'Server processed the sanitized page graph.',
  }
}

function buildFallbackCommand(payload) {
  const candidates = payload?.elements || []
  const taskPattern = getTaskPattern(String(payload?.task || '').toLowerCase())
  const preferred = candidates.find((element) => {
    const text = `${element.role} ${element.label}`.toLowerCase()
    return taskPattern.test(text)
  })

  return {
    type: preferred ? 'highlight' : 'none',
    targetId: preferred?.id || '',
    instruction: preferred
      ? `Highlight ${preferred.label || preferred.role} for user confirmation.`
      : 'No safe action target was found.',
  }
}

function getTaskPattern(taskText) {
  if (/log ?in|sign ?in/.test(taskText)) {
    return /(login|log in|sign in|continue)/
  }

  if (/pay|checkout|order/.test(taskText)) {
    return /(pay|checkout|place order|continue)/
  }

  if (/save|update/.test(taskText)) {
    return /(save|update|submit)/
  }

  if (/send|message|email/.test(taskText)) {
    return /(send|submit)/
  }

  return /(submit|continue|next|review|save|send|login|sign in|checkout|pay)/
}
