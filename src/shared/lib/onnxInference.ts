import * as ort from 'onnxruntime-web'
import type { SanitizedPayload, AgentCommand, ReasonResult } from '../types/netrashield'
import vocabMeta from './modelVocab.json'

type ChromeRuntimeWithUrl = {
  runtime?: {
    getURL?: (path: string) => string
  }
}

declare const chrome: ChromeRuntimeWithUrl | undefined

const VOCABULARY = vocabMeta.vocabulary
const CLASSES = vocabMeta.classes

let sessionPromise: Promise<ort.InferenceSession | null> | null = null

function getAssetUrl(relativePath: string): string {
  if (typeof chrome !== 'undefined' && chrome?.runtime?.getURL) {
    return chrome.runtime.getURL(relativePath)
  }
  return `/${relativePath}`
}

export function initOnnxEnvironment(): void {
  try {
    ort.env.wasm.wasmPaths = getAssetUrl('onnx/')
    ort.env.wasm.numThreads = 1
  } catch (err) {
    console.warn('[NetraShield ONNX] Could not configure WASM paths:', err)
  }
}

export async function getOnnxSession(): Promise<ort.InferenceSession | null> {
  if (sessionPromise) {
    return sessionPromise
  }

  sessionPromise = (async () => {
    initOnnxEnvironment()
    const modelUrl = getAssetUrl('models/intent-classifier.onnx')

    try {
      const session = await ort.InferenceSession.create(modelUrl, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      })
      return session
    } catch (directErr) {
      console.warn('[NetraShield ONNX] Direct session creation failed, trying fetch buffer:', directErr)
      try {
        const res = await fetch(modelUrl)
        if (!res.ok) {
          throw new Error(`Failed to fetch model: HTTP ${res.status}`)
        }
        const buffer = await res.arrayBuffer()
        const session = await ort.InferenceSession.create(buffer, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        })
        return session
      } catch (bufferErr) {
        console.error('[NetraShield ONNX] Failed to load ONNX model buffer:', bufferErr)
        throw bufferErr
      }
    }
  })().catch((err) => {
    sessionPromise = null
    console.error('[NetraShield ONNX] Session initialization failed:', err)
    return null
  })

  return sessionPromise
}

export function extractFeatures(task: string, payload: SanitizedPayload): Float32Array {
  const vector = new Float32Array(VOCABULARY.length)
  const tokenMap = new Map<string, number>()
  VOCABULARY.forEach((word, index) => {
    tokenMap.set(word.toLowerCase(), index)
  })

  // Tokenize task
  const taskTokens = task.toLowerCase().split(/[\s,._\-:;/?!]+/)
  for (const token of taskTokens) {
    if (tokenMap.has(token)) {
      const idx = tokenMap.get(token)!
      vector[idx] += 1.5
    }
  }

  // Tokenize sanitized element descriptors
  for (const el of payload.elements) {
    const textToScan = `${el.label || ''} ${el.role || ''}`.toLowerCase()
    const elTokens = textToScan.split(/[\s,._\-:;/?!]+/)
    for (const token of elTokens) {
      if (tokenMap.has(token)) {
        const idx = tokenMap.get(token)!
        vector[idx] += 0.5
      }
    }
  }

  // Normalize L2 norm if non-zero
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

export async function runOnnxInference(
  task: string,
  payload: SanitizedPayload
): Promise<ReasonResult | null> {
  const session = await getOnnxSession()
  if (!session) {
    return null
  }

  const features = extractFeatures(task, payload)
  const inputTensor = new ort.Tensor('float32', features, [1, VOCABULARY.length])

  const results = await session.run({ input_features: inputTensor })
  const probabilities = results.probabilities.data as Float32Array
  
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

  const command = matchIntentToElement(predictedIntent, task, payload)

  return {
    ok: true,
    source: 'local-onnx',
    command,
    rationale: `Local ONNX model predicted intent '${predictedIntent}' (${confidence}% confidence) with ${payload.redactions.length} redacted regions protected.`,
  }
}

function matchIntentToElement(
  intent: string,
  task: string,
  payload: SanitizedPayload
): AgentCommand {
  const elements = payload.elements || []

  const intentKeywords: Record<string, string[]> = {
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
    instruction: `[Local ONNX Model] Evaluated intent "${intent}", but found no interactive element to target on this view.`,
  }
}
