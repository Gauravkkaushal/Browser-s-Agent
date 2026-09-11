import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'

/**
 * The OCR pipeline (offscreen document + Tesseract.js/WASM) cannot be
 * exercised end to end here -- it needs a real Chrome extension process,
 * which this test environment does not have. What CAN be verified without
 * one: the bundled model/engine files are not corrupt, the wiring between
 * agent-background.js and offscreen.js matches on both ends, and the manifest
 * actually grants what the code uses. A live extension load in Chrome is
 * still the real test for recognition accuracy.
 */

const ROOT = path.resolve(__dirname, '../..')
const bg = fs.readFileSync(path.join(ROOT, 'public/agent-background.js'), 'utf8')
const offscreen = fs.readFileSync(path.join(ROOT, 'public/offscreen.js'), 'utf8')
const offscreenHtml = fs.readFileSync(path.join(ROOT, 'public/offscreen.html'), 'utf8')
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/manifest.json'), 'utf8'))

describe('bundled OCR assets are not corrupt', () => {
  it('ships an English traineddata that actually gunzips to a tesseract data blob', () => {
    const gz = fs.readFileSync(path.join(ROOT, 'public/tesseract/lang/eng.traineddata.gz'))
    expect(gz.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b])) // gzip magic
    const data = zlib.gunzipSync(gz)
    expect(data.length).toBeGreaterThan(1_000_000) // a real language model, not a placeholder file
  })

  it('ships a valid WASM binary for the OCR core', () => {
    const wasm = fs.readFileSync(path.join(ROOT, 'public/tesseract/core/tesseract-core-simd-lstm.wasm'))
    expect(wasm.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x61, 0x73, 0x6d])) // '\0asm'
  })

  it('ships the tesseract.js main bundle and worker script referenced by offscreen.html/js', () => {
    expect(fs.existsSync(path.join(ROOT, 'public/tesseract/tesseract.min.js'))).toBe(true)
    expect(fs.existsSync(path.join(ROOT, 'public/tesseract/worker.min.js'))).toBe(true)
  })
})

describe('offscreen document does OCR fully offline', () => {
  it('loads tesseract.min.js locally, not from a CDN', () => {
    expect(offscreenHtml).toContain('src="tesseract/tesseract.min.js"')
    expect(offscreenHtml).not.toMatch(/https?:\/\//)
  })

  it('points the worker at bundled local files via chrome.runtime.getURL, never a remote URL', () => {
    expect(offscreen).toContain("chrome.runtime.getURL('tesseract/core/tesseract-core-simd-lstm.js')")
    expect(offscreen).toContain("chrome.runtime.getURL('tesseract/worker.min.js')")
    expect(offscreen).toContain("chrome.runtime.getURL('tesseract/lang')")
    expect(offscreen).not.toMatch(/https?:\/\/.*tessdata|https?:\/\/.*jsdelivr|https?:\/\/.*unpkg/)
  })

  it('filters low-confidence words and bounds how many regions it returns', () => {
    expect(offscreen).toContain('CONFIDENCE_FLOOR')
    expect(offscreen).toContain('MAX_REGIONS')
    expect(offscreen).toMatch(/w\.confidence >= CONFIDENCE_FLOOR/)
    expect(offscreen).toContain('.slice(0, MAX_REGIONS)')
  })

  it('responds to the AGENT_OCR message the background script sends, asynchronously', () => {
    expect(offscreen).toContain("msg.type !== 'AGENT_OCR'")
    expect(offscreen).toContain('return true // keep the message channel open for the async response')
  })
})

describe('background script drives the offscreen document correctly', () => {
  it('creates the offscreen document with a WORKERS reason before using it', () => {
    expect(bg).toContain("url: 'offscreen.html'")
    expect(bg).toContain("reasons: ['WORKERS']")
  })

  it('tolerates a second createDocument call racing the first', () => {
    expect(bg).toMatch(/only .*offscreen document\|single offscreen/i)
  })

  it('sends the AGENT_OCR message with the screenshot payload', () => {
    expect(bg).toContain("chrome.runtime.sendMessage({ type: 'AGENT_OCR', screenshot: screenshotB64 })")
  })

  it('only runs OCR on the ALREADY-REDACTED screenshot, never the raw capture', () => {
    const idx = bg.indexOf('const ocr = await runOcr(shot.screenshot)')
    expect(idx).toBeGreaterThan(-1)
    // The redaction call must appear before the OCR call in the same block.
    const redactIdx = bg.indexOf('const shot = await captureRedacted(')
    expect(redactIdx).toBeGreaterThan(-1)
    expect(redactIdx).toBeLessThan(idx)
  })

  it('degrades gracefully when OCR fails, instead of failing the whole observation', () => {
    expect(bg).toContain('obs.ocr_regions = ocr.ok ? verify.regions : []')
  })
})

describe('VERIFY: re-OCR the redacted screenshot and fail closed on any leak', () => {
  // Loads the real verifyRedaction() (plus LEAK_CHECK_PATTERNS it closes
  // over) straight out of the shipped source.
  function loadVerify(): (regions: { text: string }[]) => { leaked: boolean; kinds: string[]; regions: { text: string }[] } {
    const start = bg.indexOf('const LEAK_CHECK_PATTERNS = [')
    const fnStart = bg.indexOf('function verifyRedaction(regions) {')
    expect(start).toBeGreaterThan(-1)
    expect(fnStart).toBeGreaterThan(start)
    let depth = 0
    let end = fnStart
    let started = false
    for (let i = fnStart; i < bg.length; i++) {
      if (bg[i] === '{') { depth++; started = true }
      else if (bg[i] === '}') { depth--; if (started && depth === 0) { end = i + 1; break } }
    }
    const body = bg.slice(start, end)
    // eslint-disable-next-line no-new-func
    return new Function(`${body}; return verifyRedaction;`)() as ReturnType<typeof loadVerify>
  }

  it('passes clean OCR text through untouched', () => {
    const verifyRedaction = loadVerify()
    const res = verifyRedaction([{ text: 'Submit' }, { text: 'Cancel' }])
    expect(res.leaked).toBe(false)
    expect(res.kinds).toEqual([])
    expect(res.regions.map((r) => r.text)).toEqual(['Submit', 'Cancel'])
  })

  it('catches an email the mask missed and scrubs it from the returned text', () => {
    const verifyRedaction = loadVerify()
    const res = verifyRedaction([{ text: 'contact leak@example.com here' }])
    expect(res.leaked).toBe(true)
    expect(res.kinds).toContain('EMAIL')
    expect(res.regions[0].text).not.toContain('leak@example.com')
    expect(res.regions[0].text).toContain('[LEAK-REDACTED:EMAIL]')
  })

  it('catches a card-shaped digit run', () => {
    const verifyRedaction = loadVerify()
    const res = verifyRedaction([{ text: '4111 1111 1111 1111' }])
    expect(res.leaked).toBe(true)
    expect(res.kinds).toContain('CARD')
  })

  it('runs verify on every OCR pass and withholds the screenshot on a leak', () => {
    expect(bg).toContain('const verify = ocr.ok ? verifyRedaction(ocr.regions)')
    expect(bg).toContain('if (verify.leaked) {')
    expect(bg).toContain('obs.screenshot = null')
  })

  it('reports the leak as its own distinct, greppable event', () => {
    const loop = fs.readFileSync(path.join(ROOT, 'server/loop.py'), 'utf8')
    expect(loop).toContain('"REDACTION_VERIFY_FAILED"')
  })

  it('Observation carries the leak flag and kinds, never the leaked value', () => {
    const schemas = fs.readFileSync(path.join(ROOT, 'server/schemas.py'), 'utf8')
    expect(schemas).toContain('ocr_leak_detected: bool = False')
    expect(schemas).toContain('ocr_leak_kinds: List[str]')
  })
})

describe('manifest grants exactly what offscreen OCR needs', () => {
  it('declares the offscreen permission', () => {
    expect(manifest.permissions).toContain('offscreen')
  })
})
