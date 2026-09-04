import * as ort from './onnx/ort.all.bundle.min.mjs'

const DEFAULT_SERVER_URL = 'http://localhost:8787/reason'

// 90-token vocabulary matching scripts/build-onnx-model.py
const VOCABULARY = [
  "login", "signin", "password", "user", "username", "email", "auth", "account", "passcode", "credential",
  "pay", "payment", "checkout", "card", "cvv", "buy", "purchase", "upi", "billing", "order",
  "save", "submit", "store", "confirm", "apply", "done", "keep", "finish", "record", "commit",
  "send", "message", "chat", "post", "transfer", "forward", "dispatch", "share", "mail", "sms",
  "search", "find", "query", "lookup", "explore", "filter", "browse", "seek", "check", "inspect",
  "delete", "remove", "clear", "discard", "trash", "erase", "cancel", "purge", "reset", "drop",
  "navigate", "go", "back", "forward", "home", "open", "redirect", "visit", "jump", "switch",
  "download", "export", "fetch", "extract", "saveas", "backup", "grab", "pull", "retrieve", "archive",
  "click", "button", "input", "form", "field", "select", "enter", "press", "next", "continue"
]

const CLASSES = ["login", "pay", "save", "send", "search", "delete", "navigate", "download"]

let sessionPromise = null

function initOnnx() {
  if (ort?.env?.wasm) {
    ort.env.wasm.wasmPaths = chrome.runtime.getURL('onnx/')
    ort.env.wasm.numThreads = 1
  }
}

async function getOrInitSession() {
  if (sessionPromise) return sessionPromise

  sessionPromise = (async () => {
    initOnnx()
    const modelUrl = chrome.runtime.getURL('models/intent-classifier.onnx')
    console.log('[NetraShield BG] Loading ONNX model from:', modelUrl)

    const res = await fetch(modelUrl)
    if (!res.ok) throw new Error(`Model fetch failed with status ${res.status}`)
    const buffer = await res.arrayBuffer()

    const session = await ort.InferenceSession.create(buffer, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    })
    console.log('[NetraShield BG] ONNX session ready.')
    return session
  })().catch((err) => {
    sessionPromise = null
    console.error('[NetraShield BG] Failed to initialize ONNX session:', err)
    throw err
  })

  return sessionPromise
}

function extractFeatures(task, payload) {
  const vector = new Float32Array(VOCABULARY.length)
  const tokenMap = new Map()
  VOCABULARY.forEach((word, index) => {
    tokenMap.set(word.toLowerCase(), index)
  })

  const taskTokens = String(task || '').toLowerCase().split(/[\s,._\-:;/?!]+/)
  for (const token of taskTokens) {
    if (tokenMap.has(token)) {
      vector[tokenMap.get(token)] += 1.5
    }
  }

  const elements = payload?.elements || []
  for (const el of elements) {
    const textToScan = `${el.label || ''} ${el.role || ''} ${el.type || ''}`.toLowerCase()
    const elTokens = textToScan.split(/[\s,._\-:;/?!]+/)
    for (const token of elTokens) {
      if (tokenMap.has(token)) {
        vector[tokenMap.get(token)] += 0.5
      }
    }
  }

  let norm = 0
  for (let i = 0; i < vector.length; i++) {
    norm += vector[i] * vector[i]
  }
  if (norm > 0) {
    const sqrtNorm = Math.sqrt(norm)
    for (let i = 0; i < vector.length; i++) {
      vector[i] = vector[i] / sqrtNorm
    }
  }

  return vector
}

function matchIntentToElement(intent, task, payload) {
  const elements = payload?.elements || []
  const intentKeywords = {
    login: ['login', 'sign in', 'submit', 'password', 'user', 'continue', 'auth'],
    pay: ['pay', 'payment', 'checkout', 'card', 'buy', 'purchase', 'proceed', 'order', 'upi'],
    save: ['save', 'submit', 'store', 'confirm', 'apply', 'done', 'keep', 'commit'],
    send: ['send', 'message', 'chat', 'post', 'transfer', 'forward', 'submit', 'mail', 'share'],
    search: ['search', 'find', 'query', 'filter', 'explore', 'go', 'lookup'],
    delete: ['delete', 'remove', 'clear', 'discard', 'trash', 'cancel', 'reset', 'drop', 'erase'],
    navigate: ['home', 'back', 'forward', 'menu', 'nav', 'goto', 'visit', 'open', 'switch', 'link'],
    download: ['download', 'export', 'fetch', 'extract', 'backup', 'file', 'pull', 'grab'],
  }

  const targetKeywords = intentKeywords[intent] || ['submit', 'button', 'input']
  let bestElement = elements[0]
  let bestScore = -1

  for (const el of elements) {
    let score = 0
    const text = `${el.label || ''} ${el.role || ''} ${el.id || ''}`.toLowerCase()
    for (const kw of targetKeywords) {
      if (text.includes(kw)) score += 3
    }
    if (el.role === 'button' || el.role === 'link') score += 1
    if (el.role === 'input') score += 0.5

    if (score > bestScore) {
      bestScore = score
      bestElement = el
    }
  }

  if (bestElement) {
    return {
      type: 'highlight',
      targetId: bestElement.id,
      instruction: `[Local ONNX Model] Detected intent "${intent}". Highlighted element "${bestElement.label || bestElement.role}" (ID: ${bestElement.id}) for task: "${task}".`,
    }
  }

  return {
    type: 'none',
    targetId: '',
    instruction: `[Local ONNX Model] Evaluated intent "${intent}", but found no interactive element to target.`,
  }
}

async function runLocalOnnx(payload) {
  const session = await getOrInitSession()
  const features = extractFeatures(payload.task, payload)
  const inputTensor = new ort.Tensor('float32', features, [1, VOCABULARY.length])
  const results = await session.run({ input_features: inputTensor })
  const probabilities = results.probabilities.data

  let maxScore = -1
  let predictedClassIndex = 0
  for (let i = 0; i < CLASSES.length; i++) {
    if (probabilities[i] > maxScore) {
      maxScore = probabilities[i]
      predictedClassIndex = i
    }
  }

  const predictedIntent = CLASSES[predictedClassIndex] || 'search'
  const confidence = Math.round(maxScore * 100)
  const command = matchIntentToElement(predictedIntent, payload.task, payload)

  return {
    ok: true,
    source: 'local-onnx',
    command,
    rationale: `Local on-device ONNX model inferred intent '${predictedIntent}' (${confidence}% confidence) with zero raw data exposure.`,
  }
}

async function reasonOverSanitizedContext(payload) {
  let reasoningEngine = 'auto'
  let serverUrl = DEFAULT_SERVER_URL

  try {
    const settings = await chrome.storage.sync.get({ reasoningEngine: 'auto', serverUrl: DEFAULT_SERVER_URL })
    reasoningEngine = settings.reasoningEngine || 'auto'
    serverUrl = settings.serverUrl || DEFAULT_SERVER_URL
  } catch (err) {
    console.warn('[NetraShield BG] Could not load settings, using defaults:', err)
  }

  // 1. If user selected 'server' explicitly:
  if (reasoningEngine === 'server') {
    try {
      const response = await fetch(serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (response.ok) {
        const data = await response.json()
        return {
          ok: true,
          source: 'server',
          command: data.command || buildFallbackCommand(payload),
          rationale: data.rationale || 'Server processed sanitized page graph.',
        }
      }
    } catch (serverError) {
      console.warn('[NetraShield BG] Direct server reasoning failed:', serverError)
    }

    return {
      ok: false,
      source: 'server',
      command: buildFallbackCommand(payload),
      error: `Server at ${serverUrl} was unreachable.`,
      rationale: 'Reasoning engine is set to Server Only, but connection failed.',
    }
  }

  // 2. If 'onnx' or 'auto': try local ONNX
  try {
    const onnxResult = await runLocalOnnx(payload)
    if (onnxResult) {
      return onnxResult
    }
  } catch (onnxError) {
    console.warn('[NetraShield BG] Local ONNX inference failed:', onnxError)
  }

  // If set strictly to local ONNX, do NOT send data to server
  if (reasoningEngine === 'onnx') {
    return {
      ok: true,
      source: 'extension-fallback',
      command: buildFallbackCommand(payload),
      rationale: 'Local ONNX model evaluation failed; fell back to on-device heuristics (server transmission blocked by Local ONNX mode).',
    }
  }

  // 3. Fallback to server in 'auto' mode
  try {
    const response = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (response.ok) {
      const data = await response.json()
      return {
        ok: true,
        source: 'server',
        command: data.command || buildFallbackCommand(payload),
        rationale: data.rationale || 'Server processed sanitized page graph.',
      }
    }
  } catch (serverError) {
    console.warn('[NetraShield BG] Server fallback also unreachable:', serverError)
  }

  // 4. Heuristic fallback
  return {
    ok: true,
    source: 'extension-fallback',
    command: buildFallbackCommand(payload),
    rationale: 'Extension local rule fallback used because ML model and server were unavailable.',
  }
}

function buildFallbackCommand(payload) {
  const candidates = payload?.elements || []
  const preferred = candidates.find((el) => {
    const text = `${el.role} ${el.label}`.toLowerCase()
    return /submit|login|pay|save|send|continue|next/.test(text)
  })

  return {
    type: preferred ? 'highlight' : 'none',
    targetId: preferred?.id || '',
    instruction: preferred
      ? `Highlight ${preferred.label || preferred.role} for user confirmation.`
      : 'No safe action target was found.',
  }
}

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
