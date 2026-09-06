import * as ort from 'onnxruntime-web'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

const modelPath = path.join(rootDir, 'public', 'models', 'intent-classifier.onnx')
const vocabPath = path.join(rootDir, 'src', 'shared', 'lib', 'modelVocab.json')

console.log('Testing ONNX model inference from:', modelPath)

const vocabData = JSON.parse(fs.readFileSync(vocabPath, 'utf8'))
const VOCABULARY = vocabData.vocabulary
const CLASSES = vocabData.classes

function extractFeatures(task, elements) {
  const vector = new Float32Array(VOCABULARY.length)
  const tokenMap = new Map()
  VOCABULARY.forEach((w, i) => tokenMap.set(w.toLowerCase(), i))

  const taskTokens = String(task).toLowerCase().split(/[\s,._\-:;/?!]+/)
  for (const token of taskTokens) {
    if (tokenMap.has(token)) vector[tokenMap.get(token)] += 1.5
  }

  for (const el of elements) {
    const text = `${el.label || ''} ${el.role || ''}`.toLowerCase()
    for (const token of text.split(/[\s,._\-:;/?!]+/)) {
      if (tokenMap.has(token)) vector[tokenMap.get(token)] += 0.5
    }
  }

  let norm = 0
  for (let i = 0; i < vector.length; i++) norm += vector[i] * vector[i]
  if (norm > 0) {
    const sqrt = Math.sqrt(norm)
    for (let i = 0; i < vector.length; i++) vector[i] /= sqrt
  }
  return vector
}

async function runTest() {
  const modelBuffer = fs.readFileSync(modelPath)
  const session = await ort.InferenceSession.create(modelBuffer)
  console.log('✓ Model loaded successfully into ONNX runtime session!')

  const testCases = [
    {
      task: 'Please log in to my dashboard account with credentials',
      elements: [
        { id: 'btn-login', role: 'button', label: 'Log In' },
        { id: 'input-user', role: 'input', label: 'Username' }
      ],
      expectedIntent: 'login'
    },
    {
      task: 'Pay for my monthly order subscription via card',
      elements: [
        { id: 'btn-pay', role: 'button', label: 'Pay Now' },
        { id: 'card-input', role: 'input', label: 'Card Number' }
      ],
      expectedIntent: 'pay'
    },
    {
      task: 'Save this form draft and submit for approval',
      elements: [
        { id: 'btn-save', role: 'button', label: 'Save Changes' },
        { id: 'btn-submit', role: 'button', label: 'Submit Application' }
      ],
      expectedIntent: 'save'
    },
    {
      task: 'Send a message to user support on the chat box',
      elements: [
        { id: 'btn-send', role: 'button', label: 'Send Message' }
      ],
      expectedIntent: 'send'
    },
    {
      task: 'Search for recent product catalog items and explore',
      elements: [
        { id: 'search-box', role: 'input', label: 'Search Query' }
      ],
      expectedIntent: 'search'
    }
  ]

  let passed = 0
  for (const tc of testCases) {
    const features = extractFeatures(tc.task, tc.elements)
    const tensor = new ort.Tensor('float32', features, [1, VOCABULARY.length])
    const results = await session.run({ input_features: tensor })
    const probabilities = results.probabilities.data

    let maxScore = -1
    let bestIdx = 0
    for (let i = 0; i < CLASSES.length; i++) {
      if (probabilities[i] > maxScore) {
        maxScore = probabilities[i]
        bestIdx = i
      }
    }

    const predicted = CLASSES[bestIdx]
    const confidence = (maxScore * 100).toFixed(1)
    const isCorrect = predicted === tc.expectedIntent

    console.log(`- Task: "${tc.task}"`)
    console.log(`  Predicted: ${predicted} (${confidence}% confidence) | Expected: ${tc.expectedIntent} -> ${isCorrect ? 'PASS ✓' : 'FAIL ✗'}`)

    if (isCorrect) passed++
  }

  console.log(`\nResults: ${passed}/${testCases.length} tests passed.`)
  if (passed !== testCases.length) {
    process.exit(1)
  }
}

runTest().catch((err) => {
  console.error('Test failed with error:', err)
  process.exit(1)
})
