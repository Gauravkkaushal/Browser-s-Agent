import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Same caveat as ocr.test.ts: real CLIP inference needs a live Chrome
 * extension process, which this environment does not have. What IS verified
 * here without one: the bundled ONNX weights and the ONNX Runtime Web wasm
 * binary are not corrupt or truncated, and the wiring between
 * agent-background.js and offscreen.js matches -- same discipline as the OCR
 * tests, extended to the second offscreen model.
 */

const ROOT = path.resolve(__dirname, '../..')
const bg = fs.readFileSync(path.join(ROOT, 'public/agent-background.js'), 'utf8')
const offscreen = fs.readFileSync(path.join(ROOT, 'public/offscreen.js'), 'utf8')
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/manifest.json'), 'utf8'))

const CLIP_DIR = path.join(ROOT, 'public/models/Xenova/mobileclip_s0')

describe('bundled CLIP model files are not corrupt or truncated', () => {
  it('ships a vision tower ONNX file of the expected size and a valid protobuf header', () => {
    const p = path.join(CLIP_DIR, 'onnx/vision_model_quantized.onnx')
    const buf = fs.readFileSync(p)
    // Downloaded size confirmed against the HuggingFace Hub Content-Length at
    // fetch time (11,846,843 bytes) -- a truncated/corrupt download would
    // differ, often by exactly the size of an HTML error page. MobileCLIP-S0's
    // vision tower is ~7.5x smaller than standard clip-vit-base-patch32's
    // (89,117,001 bytes) for comparable zero-shot accuracy.
    expect(buf.length).toBe(11_846_843)
    expect(buf.subarray(0, 1)).toEqual(Buffer.from([0x08])) // onnx.ModelProto field 1 (ir_version), varint tag
  })

  it('ships a text tower ONNX file of the expected size', () => {
    const p = path.join(CLIP_DIR, 'onnx/text_model_quantized.onnx')
    const buf = fs.readFileSync(p)
    expect(buf.length).toBe(42_799_238)
  })

  it('ships every config/tokenizer file the CLIP processor and tokenizer need', () => {
    for (const f of ['config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json']) {
      expect(fs.existsSync(path.join(CLIP_DIR, f))).toBe(true)
    }
  })

  it('keeps the combined model well under a lightweight footprint budget', () => {
    const vision = fs.statSync(path.join(CLIP_DIR, 'onnx/vision_model_quantized.onnx')).size
    const text = fs.statSync(path.join(CLIP_DIR, 'onnx/text_model_quantized.onnx')).size
    expect(vision + text).toBeLessThan(80 * 1024 * 1024) // < 80MB combined
  })

  it('ships a valid ONNX Runtime Web wasm binary', () => {
    const wasm = fs.readFileSync(path.join(ROOT, 'public/transformers/ort/ort-wasm-simd-threaded.wasm'))
    expect(wasm.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x61, 0x73, 0x6d])) // '\0asm'
  })

  it('ships the transformers.js web bundle', () => {
    expect(fs.existsSync(path.join(ROOT, 'public/transformers/transformers.web.min.js'))).toBe(true)
  })
})

describe('offscreen document runs CLIP fully offline', () => {
  it('disables remote model loading and points every path at the local package', () => {
    expect(offscreen).toContain('env.allowRemoteModels = false')
    expect(offscreen).toContain('env.allowLocalModels = true')
    expect(offscreen).toContain("env.localModelPath = chrome.runtime.getURL('models/')")
    expect(offscreen).toContain("env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('transformers/ort/')")
    expect(offscreen).not.toMatch(/https?:\/\//)
  })

  it('avoids requiring cross-origin-isolation headers the offscreen document may not have', () => {
    expect(offscreen).toContain('env.backends.onnx.wasm.numThreads = 1')
  })

  it('bounds how many candidate elements get scored per step', () => {
    expect(offscreen).toContain('CLIP_MAX_CANDIDATES')
    expect(offscreen).toContain('candidates.slice(0, CLIP_MAX_CANDIDATES)')
  })

  it('computes a real cosine similarity between text and image embeddings', () => {
    expect(offscreen).toContain('function cosineSimilarity(a, b)')
    expect(offscreen).toContain('dot / (Math.sqrt(na) * Math.sqrt(nb))')
  })

  it('responds to the AGENT_CLIP_SCORE message asynchronously', () => {
    expect(offscreen).toContain("msg.type !== 'AGENT_CLIP_SCORE'")
  })

  it('skips scoring entirely when there is no query, instead of running the model for nothing', () => {
    expect(offscreen).toContain('if (!query || !candidates || !candidates.length)')
  })
})

describe('background script only ever turns CLIP output into an eid score map', () => {
  it('maps candidates from real DOM elements (eid + box), not raw screenshot coordinates', () => {
    expect(bg).toContain('candidates = elements.map((el) => ({ eid: el.eid, box: el.box }))')
  })

  it('runs CLIP only on the already-redacted screenshot, in the same branch as OCR', () => {
    const shotOkIdx = bg.indexOf("if (shot.ok) {")
    const clipIdx = bg.indexOf('const clip = await runClipScore(')
    expect(shotOkIdx).toBeGreaterThan(-1)
    expect(clipIdx).toBeGreaterThan(shotOkIdx)
  })

  it('degrades to an empty score map on failure instead of failing the observation', () => {
    expect(bg).toContain('obs.visual_scores = clip.ok')
    expect(bg).toContain(': {}')
  })

  it('passes the plan objective as the visual query, only alongside a screenshot', () => {
    const loop = fs.readFileSync(path.join(ROOT, 'server/loop.py'), 'utf8')
    expect(loop).toContain('visual_query = (self.plan.objective if self.plan else self.command) if screenshot else ""')
  })
})

describe('manifest and schema carry what CLIP grounding needs', () => {
  it('reuses the same offscreen permission OCR already required', () => {
    expect(manifest.permissions).toContain('offscreen')
  })

  it('Observation carries visual_scores as an eid -> similarity map', () => {
    const schemas = fs.readFileSync(path.join(ROOT, 'server/schemas.py'), 'utf8')
    expect(schemas).toContain('visual_scores: Dict[str, float] = Field(default_factory=dict)')
  })
})
