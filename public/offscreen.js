/*
 * offscreen.js -- runs inside the extension's offscreen document.
 *
 * The service worker (agent-background.js) cannot reliably run heavy WASM
 * (Tesseract's OCR engine, ONNX Runtime for CLIP) itself -- MV3 service
 * workers are torn down mid-task and have a cut-down DOM. An offscreen
 * document is a normal page the extension controls, with no tab, no address
 * bar, invisible to the user -- exactly the place NETRA's own diagram puts
 * this runtime.
 *
 * Everything here is local. tesseract.min.js, its wasm core, the English
 * language data, the CLIP ONNX weights and the ONNX Runtime Web wasm binary
 * all ship inside the extension (public/tesseract/, public/models/,
 * public/transformers/); nothing is fetched from a CDN, so both OCR and
 * vision grounding work with the network off.
 */

import {
  env,
  AutoTokenizer,
  AutoProcessor,
  CLIPTextModelWithProjection,
  CLIPVisionModelWithProjection,
  RawImage,
} from './transformers/transformers.web.min.js'

// Browser defaults to allowLocalModels=false and a remote HuggingFace Hub
// host. Point both at the files bundled in the package instead -- the same
// "on-device, not just on-localhost" discipline as the Ollama/Tesseract paths.
env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = chrome.runtime.getURL('models/')
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('transformers/ort/')
// The threaded wasm binary works single-threaded too; forcing 1 thread avoids
// depending on cross-origin-isolation headers the offscreen document may not
// have, trading a little speed for working everywhere without configuration.
env.backends.onnx.wasm.numThreads = 1

// MobileCLIP-S0 (Apple's edge-optimized CLIP family) -- same CLIPModel graph
// shape as standard CLIP, so it drops into the same classes below, but the
// vision tower is ~7.5x smaller and the text tower ~1.5x smaller than
// clip-vit-base-patch32 (11.8MB + 42.8MB vs 89MB + 64.5MB quantized) for
// comparable zero-shot accuracy -- the actual "lightweight" tradeoff this
// problem statement asks for, not just a smaller number on a slide.
const CLIP_MODEL_ID = 'Xenova/mobileclip_s0'
const CLIP_MAX_CANDIDATES = 12 // bounds cost -- this scores the top DOM-ranked elements, not the whole page

let clipPromise = null
function getClip() {
  if (!clipPromise) {
    clipPromise = Promise.all([
      AutoTokenizer.from_pretrained(CLIP_MODEL_ID),
      CLIPTextModelWithProjection.from_pretrained(CLIP_MODEL_ID, { dtype: 'q8' }),
      AutoProcessor.from_pretrained(CLIP_MODEL_ID),
      CLIPVisionModelWithProjection.from_pretrained(CLIP_MODEL_ID, { dtype: 'q8' }),
    ]).then(([tokenizer, textModel, processor, visionModel]) => (
      { tokenizer, textModel, processor, visionModel }
    ))
  }
  return clipPromise
}

function cosineSimilarity(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function cropRegion(bitmap, box, scaleX, scaleY) {
  const [x, y, w, h] = box
  const sx = Math.max(0, Math.min(bitmap.width - 1, Math.round(x * scaleX)))
  const sy = Math.max(0, Math.min(bitmap.height - 1, Math.round(y * scaleY)))
  const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(w * scaleX)))
  const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(h * scaleY)))
  const canvas = new OffscreenCanvas(sw, sh)
  canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh)
  return canvas
}

/**
 * Score up to CLIP_MAX_CANDIDATES elements by how well their cropped, on-screen
 * appearance matches a text description -- real CLIP vision+text embeddings,
 * cosine-compared, not a keyword match. This is the local, on-device element
 * grounding step: a signal ADDED to the DOM-based eid resolution the executor
 * already relies on, never a replacement for it (no eid is ever invented from
 * a pixel coordinate here -- see agent-content.js's own rule on that).
 */
async function runClipScore(screenshotB64, candidates, query, viewport) {
  const started = performance.now()
  if (!query || !candidates || !candidates.length) {
    return { ok: true, scores: [], ms: 0 }
  }
  const { tokenizer, textModel, processor, visionModel } = await getClip()

  const blob = await (await fetch('data:image/jpeg;base64,' + screenshotB64)).blob()
  const bitmap = await createImageBitmap(blob)
  const scaleX = viewport && viewport.w ? bitmap.width / viewport.w : 1
  const scaleY = viewport && viewport.h ? bitmap.height / viewport.h : 1

  const textInputs = tokenizer([query], { padding: true, truncation: true })
  const { text_embeds: textEmbeds } = await textModel(textInputs)
  const textDim = textEmbeds.dims[textEmbeds.dims.length - 1]
  const queryVec = Array.from(textEmbeds.data.slice(0, textDim))

  const scores = []
  for (const c of candidates.slice(0, CLIP_MAX_CANDIDATES)) {
    if (!Array.isArray(c.box) || c.box.length < 4 || c.box[2] <= 0 || c.box[3] <= 0) continue
    try {
      const canvas = cropRegion(bitmap, c.box, scaleX, scaleY)
      const image = await RawImage.read(canvas)
      const imageInputs = await processor(image)
      const { image_embeds: imageEmbeds } = await visionModel(imageInputs)
      const imgDim = imageEmbeds.dims[imageEmbeds.dims.length - 1]
      const imgVec = Array.from(imageEmbeds.data.slice(0, imgDim))
      scores.push({ eid: c.eid, score: Math.round(cosineSimilarity(queryVec, imgVec) * 1000) / 1000 })
    } catch (e) {
      // One bad crop (a zero-area box, a decode failure) should not sink the
      // whole batch -- it is simply left unscored.
    }
  }
  scores.sort((a, b) => b.score - a.score)
  return { ok: true, scores, ms: Math.round(performance.now() - started) }
}

const CONFIDENCE_FLOOR = 35 // Tesseract's own 0-100 scale; below this a "word" is usually noise, not text.
const MAX_REGIONS = 60 // Bounds the payload -- a page is not read word by word by a reasoner prompt.

let workerPromise = null

function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('eng', 1, {
      corePath: chrome.runtime.getURL('tesseract/core/tesseract-core-simd-lstm.js'),
      workerPath: chrome.runtime.getURL('tesseract/worker.min.js'),
      langPath: chrome.runtime.getURL('tesseract/lang'),
      cacheMethod: 'none', // it's a local file already; no benefit to caching it again
      gzip: true,
      logger: () => {},
    })
  }
  return workerPromise
}

async function runOcr(screenshotB64) {
  const started = performance.now()
  const worker = await getWorker()
  const { data } = await worker.recognize('data:image/jpeg;base64,' + screenshotB64)
  const words = (data.words || [])
    .filter((w) => w.text && w.text.trim() && w.confidence >= CONFIDENCE_FLOOR)
    .map((w) => ({
      text: w.text.trim(),
      confidence: Math.round(w.confidence),
      box: [w.bbox.x0, w.bbox.y0, w.bbox.x1 - w.bbox.x0, w.bbox.y1 - w.bbox.y0],
    }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_REGIONS)
  return {
    ok: true,
    regions: words,
    ms: Math.round(performance.now() - started),
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'AGENT_OCR') return false
  runOcr(msg.screenshot)
    .then((res) => sendResponse(res))
    .catch((e) => sendResponse({ ok: false, error: 'ocr failed: ' + (e && e.message || e) }))
  return true // keep the message channel open for the async response
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'AGENT_CLIP_SCORE') return false
  runClipScore(msg.screenshot, msg.candidates, msg.query, msg.viewport)
    .then((res) => sendResponse(res))
    .catch((e) => sendResponse({ ok: false, error: 'clip scoring failed: ' + (e && e.message || e) }))
  return true
})
