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

// transformers.js is loaded on first CLIP use, not at module start. As a static
// import, any failure in it (a bundle or ORT-backend problem) killed this whole
// module -- including the OCR listener below -- so every OCR request hung
// forever with no error, and no picture was ever read.
let transformers = null
async function loadTransformers() {
  if (transformers) return transformers
  // The bundled build: transformers.web.min.js imports 'onnxruntime-web/webgpu'
  // by bare name, which a browser cannot resolve -- so it never loaded at all.
  const t = await import('./transformers/transformers.min.js')
  const env = t.env
  // Browser defaults to allowLocalModels=false and a remote HuggingFace Hub
  // host. Point both at the files bundled in the package instead -- the same
  // "on-device, not just on-localhost" discipline as the Ollama/Tesseract paths.
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.localModelPath = chrome.runtime.getURL('models/')
  // Name the plain wasm build explicitly; left to choose, this bundle asks for an
  // asyncify build (+23MB) that the package does not need to ship.
  env.backends.onnx.wasm.wasmPaths = {
    mjs: chrome.runtime.getURL('transformers/ort/ort-wasm-simd-threaded.mjs'),
    wasm: chrome.runtime.getURL('transformers/ort/ort-wasm-simd-threaded.wasm'),
  }
  // The threaded wasm binary works single-threaded too; forcing 1 thread avoids
  // depending on cross-origin-isolation headers the offscreen document may not
  // have, trading a little speed for working everywhere without configuration.
  env.backends.onnx.wasm.numThreads = 1
  transformers = t
  return t
}

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
    clipPromise = loadTransformers().then((t) => Promise.all([
      t.AutoTokenizer.from_pretrained(CLIP_MODEL_ID),
      t.CLIPTextModelWithProjection.from_pretrained(CLIP_MODEL_ID, { dtype: 'q8' }),
      t.AutoProcessor.from_pretrained(CLIP_MODEL_ID),
      t.CLIPVisionModelWithProjection.from_pretrained(CLIP_MODEL_ID, { dtype: 'q8' }),
    ])).then(([tokenizer, textModel, processor, visionModel]) => (
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
  const { RawImage } = await loadTransformers()

  // Not fetch(data:...): this page's connect-src does not allow data: URLs.
  const blob = new Blob([Uint8Array.from(atob(screenshotB64), (c) => c.charCodeAt(0))], { type: 'image/jpeg' })
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
      // Next to worker.min.js: the core looks for its .wasm in the worker's own
      // folder, so in a core/ subfolder every OCR call silently 404'd.
      corePath: chrome.runtime.getURL('tesseract/tesseract-core-simd-lstm.js'),
      workerPath: chrome.runtime.getURL('tesseract/worker.min.js'),
      langPath: chrome.runtime.getURL('tesseract/lang'),
      cacheMethod: 'none', // it's a local file already; no benefit to caching it again
      // Start the worker from the packaged file itself. The default wraps it in a
      // blob: URL, and a blob worker may not importScripts() extension files --
      // which made every OCR call fail with "worker.min.js failed to load".
      workerBlobURL: false,
      gzip: true,
      logger: () => {},
    })
  }
  return workerPromise
}

async function runOcr(screenshotB64, maxRegions = MAX_REGIONS) {
  const started = performance.now()
  const worker = await getWorker()
  // Tesseract.js 6+ returns word boxes only when blocks are asked for; data.words
  // is gone, which is why every OCR result came back as "0 words".
  const { data } = await worker.recognize('data:image/jpeg;base64,' + screenshotB64, {}, { blocks: true })
  const tessLines = (data.blocks || []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines))
  // Tesseract's own lines: right for text at any angle once the picture is
  // upright, where grouping words by height alone is not.
  const lines = tessLines.map((l) => {
    const ws = l.words.filter((w) => w.text && w.text.trim() && w.confidence >= CONFIDENCE_FLOOR)
    if (!ws.length) return null
    const x0 = Math.min(...ws.map((w) => w.bbox.x0))
    const y0 = Math.min(...ws.map((w) => w.bbox.y0))
    const x1 = Math.max(...ws.map((w) => w.bbox.x1))
    const y1 = Math.max(...ws.map((w) => w.bbox.y1))
    return { text: ws.map((w) => w.text.trim()).join(' '), box: [x0, y0, x1 - x0, y1 - y0] }
  }).filter(Boolean)
  const strong = tessLines.reduce((n, l) => n + l.words.filter((w) => w.confidence >= 70).length, 0)
  const words = tessLines.flatMap((l) => l.words)
    .filter((w) => w.text && w.text.trim() && w.confidence >= CONFIDENCE_FLOOR)
    .map((w) => ({
      text: w.text.trim(),
      confidence: Math.round(w.confidence),
      box: [w.bbox.x0, w.bbox.y0, w.bbox.x1 - w.bbox.x0, w.bbox.y1 - w.bbox.y0],
    }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, maxRegions)
  return {
    ok: true,
    regions: words,
    lines: lines,
    strong: strong, // confident words: how "upright" the picture read
    ms: Math.round(performance.now() - started),
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'AGENT_OCR') return false
  runOcr(msg.screenshot, msg.max_regions || MAX_REGIONS)
    .then((res) => sendResponse(res))
    .catch((e) => sendResponse({ ok: false, error: 'ocr failed: ' + (e && e.message || e) }))
  return true // keep the message channel open for the async response
})

// Faces inside pictures (an ID-card photo, a certificate portrait). YOLOS-tiny
// (q8, ~9.7MB, bundled) finds people; the head is the top of a person box.
// shortcut: person detector, not a face detector -- a full-body photo blurs
// its top half; swap in a dedicated face model if one ships for transformers.js.
const PERSON_MODEL_ID = 'Xenova/yolos-tiny'
const PERSON_MIN_SCORE = 0.6
const HEAD_SHARE = 0.8 // of a person box: head, chin and neck on an ID photo
const FACE_PAD = 0.1 // extra margin on every side, so hair and jaw edges stay covered

let personPromise = null
let faceStage = 'idle' // reported on a timeout, so a hang says where it hung
async function findFaces(imageB64) {
  const started = performance.now()
  faceStage = 'loading transformers.js'
  const t = await loadTransformers()
  if (!personPromise) {
    faceStage = 'loading person model'
    personPromise = t.pipeline('object-detection', PERSON_MODEL_ID, { dtype: 'q8', device: 'wasm' })
  }
  const detect = await personPromise
  faceStage = 'decoding picture'
  // Decode with the platform, not RawImage.read: that fetch()es the data: URL,
  // which this page's connect-src does not allow.
  const bytes = Uint8Array.from(atob(imageB64), (c) => c.charCodeAt(0))
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
  // Pad to a square: this YOLOS export's position embeddings only broadcast
  // for some aspect ratios, and a wide card crashed OrtRun ("15 by 77").
  // Capped at 512 so the input is small and the same shape every time.
  const side = Math.min(512, Math.max(bmp.width, bmp.height))
  const k = side / Math.max(bmp.width, bmp.height)
  const W = bmp.width * k
  const H = bmp.height * k
  const canvas = new OffscreenCanvas(side, side)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, side, side)
  ctx.drawImage(bmp, 0, 0, W, H)
  const image = await t.RawImage.fromCanvas(canvas)
  faceStage = 'detecting'
  const found = await detect(image, { threshold: PERSON_MIN_SCORE })
  faceStage = 'done'
  const faces = found
    .filter((d) => d.label === 'person')
    .map((d) => {
      const { xmin, ymin, xmax, ymax } = d.box
      const padX = (xmax - xmin) * FACE_PAD
      const padY = (ymax - ymin) * FACE_PAD
      const x0 = Math.max(0, xmin - padX)
      const y0 = Math.max(0, ymin - padY)
      const x1 = Math.min(W, xmax + padX)
      const y1 = Math.min(H, ymin + (ymax - ymin) * HEAD_SHARE + padY)
      // Fractions of the picture (not the padded square), like the OCR boxes.
      return [x0 / W, y0 / H, (x1 - x0) / W, (y1 - y0) / H]
    })
    .filter((f) => f[2] > 0 && f[3] > 0)
  return { ok: true, faces, ms: Math.round(performance.now() - started) }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'AGENT_FACE_STAGE') return false
  sendResponse({ stage: faceStage })
  return false
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'AGENT_FACES') return false
  findFaces(msg.image)
    .then((res) => sendResponse(res))
    .catch((e) => sendResponse({ ok: false, error: 'face detection failed: ' + (e && e.message || e) }))
  return true
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'AGENT_CLIP_SCORE') return false
  runClipScore(msg.screenshot, msg.candidates, msg.query, msg.viewport)
    .then((res) => sendResponse(res))
    .catch((e) => sendResponse({ ok: false, error: 'clip scoring failed: ' + (e && e.message || e) }))
  return true
})
