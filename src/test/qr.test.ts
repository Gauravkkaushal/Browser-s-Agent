import fs from 'node:fs'
import path from 'node:path'
import QRCode from 'qrcode'
import { describe, expect, it } from 'vitest'

/**
 * QR detection (jsQR) runs synchronously inside agent-background.js itself --
 * no offscreen document, no model file, just a ~257KB pure-JS library reading
 * pixels the service worker already has. jsQR's core decoder is plain JS with
 * no browser-only APIs, so unlike OCR/CLIP it CAN be exercised for real here:
 * a QR code is generated with the `qrcode` package (dev-only, never shipped),
 * rasterized to raw RGBA pixels by hand, and fed through the real bundled
 * jsQR.js. What still needs a live Chrome extension is only the screen
 * capture and canvas plumbing around it, not the decode itself.
 */

const ROOT = path.resolve(__dirname, '../..')
const bg = fs.readFileSync(path.join(ROOT, 'public/agent-background.js'), 'utf8')

type JsQrResult = { data: string; location: { topLeftCorner: { x: number; y: number }; topRightCorner: { x: number; y: number }; bottomLeftCorner: { x: number; y: number }; bottomRightCorner: { x: number; y: number } } } | null
type JsQrFn = (data: Uint8ClampedArray, width: number, height: number) => JsQrResult

/** Loads the real, unmodified jsQR.js UMD bundle by giving it real CJS globals. */
function loadJsQR(): JsQrFn {
  const src = fs.readFileSync(path.join(ROOT, 'public/jsqr/jsQR.js'), 'utf8')
  const mod = { exports: {} as unknown }
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', src)(mod, mod.exports)
  return mod.exports as JsQrFn
}

describe('bundled jsQR library is not corrupt', () => {
  it('ships jsQR.js as a real UMD bundle that sets self.jsQR', () => {
    const p = path.join(ROOT, 'public/jsqr/jsQR.js')
    expect(fs.existsSync(p)).toBe(true)
    const src = fs.readFileSync(p, 'utf8')
    expect(src).toContain('root["jsQR"] = factory()')
    expect(src.length).toBeGreaterThan(100_000) // a real decoder, not a stub
  })
})

describe('QR detection runs on the raw capture, before any blackout', () => {
  it('imports jsQR.js for its side effect at module scope', () => {
    expect(bg).toContain("import './jsqr/jsQR.js'")
  })

  it('detects QR boxes right after drawImage, before the sensitive_boxes blackout loop', () => {
    const drawIdx = bg.indexOf('ctx.drawImage(bmp, 0, 0)')
    const qrIdx = bg.indexOf('const qrBoxes = detectQrBoxes(ctx, bmp.width, bmp.height)')
    const blackoutIdx = bg.indexOf("ctx.fillStyle = '#000000'")
    expect(drawIdx).toBeGreaterThan(-1)
    expect(qrIdx).toBeGreaterThan(drawIdx)
    expect(blackoutIdx).toBeGreaterThan(qrIdx)
  })

  it('blacks out every detected QR box, same as sensitive_boxes', () => {
    expect(bg).toContain('for (const q of qrBoxes) {')
    expect(bg).toContain('ctx.fillRect(Math.round(q.x) - pad')
  })

  it('degrades to no boxes instead of throwing when jsQR is unavailable or errors', () => {
    expect(bg).toContain("if (typeof self.jsQR !== 'function') return []")
    expect(bg).toMatch(/catch \(e\) \{\s*return \[\]\s*\}/)
  })

  it('reports how many QR codes were found, for the cockpit and audit trail', () => {
    expect(bg).toContain('qr_detected: qrBoxes.length')
    expect(bg).toContain('obs.qr_detected = shot.ok ? shot.qr_detected : 0')
  })
})

describe('real QR round-trip: the bundled jsQR.js actually decodes a real code', () => {
  // Rasterizes a real QR code's module matrix to raw RGBA pixels by hand --
  // no canvas, no PNG codec, just the same bit grid a screen would show.
  function rasterizeQr(text: string, scale = 6, quietModules = 4) {
    const qr = QRCode.create(text, { errorCorrectionLevel: 'M' })
    const n = qr.modules.size
    const quiet = quietModules * scale
    const size = n * scale + quiet * 2
    const pixels = new Uint8ClampedArray(size * size * 4).fill(255)
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!qr.modules.data[y * n + x]) continue
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const idx = ((quiet + y * scale + dy) * size + (quiet + x * scale + dx)) * 4
            pixels[idx] = 0; pixels[idx + 1] = 0; pixels[idx + 2] = 0; pixels[idx + 3] = 255
          }
        }
      }
    }
    return { pixels, size }
  }

  it('the real bundled jsQR.js decodes a real UPI-style payment QR back to its exact text', () => {
    const jsQR = loadJsQR()
    const payload = 'upi://pay?pa=merchant@examplebank&pn=Test&am=499.00'
    const { pixels, size } = rasterizeQr(payload)
    const result = jsQR(pixels, size, size)
    expect(result).not.toBeNull()
    expect(result!.data).toBe(payload)
    expect(result!.location).toBeTruthy()
  })

  it("the real detectQrBoxes() finds the code's location and NEVER surfaces the decoded text", () => {
    // Extract the real function by brace-matching, same technique the other
    // suites use, and run it against a mocked ctx.getImageData() backed by
    // real rasterized pixels + the real jsQR decoder as self.jsQR.
    const start = bg.indexOf('function detectQrBoxes(ctx, width, height) {')
    expect(start).toBeGreaterThan(-1)
    let depth = 0
    let end = start
    let started = false
    for (let i = start; i < bg.length; i++) {
      if (bg[i] === '{') { depth++; started = true }
      else if (bg[i] === '}') { depth--; if (started && depth === 0) { end = i + 1; break } }
    }
    const body = bg.slice(start, end)
    const jsQR = loadJsQR()
    const payload = 'upi://pay?pa=merchant@examplebank&pn=Test&am=250.00'
    const { pixels, size } = rasterizeQr(payload)
    const ctx = { getImageData: () => ({ data: pixels }) }

    // eslint-disable-next-line no-new-func
    const detectQrBoxes = new Function('self', `${body}; return detectQrBoxes;`)({ jsQR })
    const boxes = detectQrBoxes(ctx, size, size)

    expect(boxes.length).toBe(1)
    expect(boxes[0].w).toBeGreaterThan(0)
    expect(boxes[0].h).toBeGreaterThan(0)
    // The box must cover roughly the code's real footprint, not the whole
    // canvas or nothing -- proof this is a real located region, not a guess.
    expect(boxes[0].w).toBeGreaterThan(size * 0.3)
    expect(boxes[0].w).toBeLessThan(size)
    // The returned boxes must never carry the decoded payload -- only x/y/w/h.
    expect(JSON.stringify(boxes)).not.toContain(payload)
    expect(Object.keys(boxes[0]).sort()).toEqual(['h', 'w', 'x', 'y'])
  })
})

describe('Observation and cockpit carry qr_detected as a count only', () => {
  it('schema field is a count, not the decoded QR content', () => {
    const schemas = fs.readFileSync(path.join(ROOT, 'server/schemas.py'), 'utf8')
    expect(schemas).toContain('qr_detected: int = 0')
  })

  it('loop.py emits it on OBSERVATION_RECEIVED', () => {
    const loop = fs.readFileSync(path.join(ROOT, 'server/loop.py'), 'utf8')
    expect(loop).toContain('"qr_detected": obs.qr_detected')
  })
})

describe('QR-shaped regions are masked even when they do not decode', () => {
  const body = bg.slice(bg.indexOf('function qrLikeBoxes('), bg.indexOf('async function captureRedacted('))
  const qrLikeBoxes = new Function(`${body}; return qrLikeBoxes`)() as
    (d: Uint8ClampedArray, w: number, h: number) => number[][]

  function canvas(w: number, h: number) {
    const data = new Uint8ClampedArray(w * h * 4).fill(255)
    const dot = (x: number, y: number) => { const i = (y * w + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0 }
    return { data, dot }
  }

  it('finds a random module grid (an undecodable QR) where it is', () => {
    const { data, dot } = canvas(512, 512)
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    // 33x33 modules of 4px at (300, 100): a 132px "QR" with no valid data in it.
    for (let my = 0; my < 33; my++) for (let mx = 0; mx < 33; mx++) {
      if (rnd() < 0.5) continue
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) dot(300 + mx * 4 + x, 100 + my * 4 + y)
    }
    const boxes = qrLikeBoxes(data, 512, 512)
    expect(boxes.length).toBe(1)
    const [x, y, bw, bh] = boxes[0]
    expect(x).toBeGreaterThanOrEqual(290)
    expect(y).toBeGreaterThanOrEqual(90)
    expect(x + bw).toBeLessThanOrEqual(445)
    expect(y + bh).toBeLessThanOrEqual(245)
  })

  it('leaves lines of text alone', () => {
    const { data, dot } = canvas(512, 512)
    // Twelve "text lines": dense dashes 12px tall with 14px gaps between lines.
    for (let line = 0; line < 12; line++) for (let x = 20; x < 480; x++) {
      if (x % 5 < 2) continue
      for (let y = 0; y < 12; y++) dot(x, 40 + line * 26 + y)
    }
    expect(qrLikeBoxes(data, 512, 512)).toEqual([])
  })
})

describe('a sideways picture is read upright and masked where the text really is', () => {
  const body = bg.slice(bg.indexOf('function unrotateFraction('), bg.indexOf('/**', bg.indexOf('function unrotateFraction(')))
  const unrotate = new Function(`${body}; return unrotateFraction`)() as (b: number[], r: number) => number[]

  // Picture 200 wide x 100 tall; a word box sits at x 20..60, y 10..30.
  // Turned 90 clockwise (100 x 200), point (x, y) moves to (100 - y, x).
  const turnedCW = [ (100 - 30) / 100, 20 / 200, 20 / 100, 40 / 200 ]
  // Turned 270 clockwise (100 x 200), point (x, y) moves to (y, 200 - x).
  const turnedCCW = [ 10 / 100, (200 - 60) / 200, 20 / 100, 40 / 200 ]
  const original = [20 / 200, 10 / 100, 40 / 200, 20 / 100]

  it('maps a box back from a 90 degree turn', () => {
    unrotate(turnedCW, 90).forEach((v, i) => expect(v).toBeCloseTo(original[i], 9))
  })

  it('maps a box back from a 270 degree turn', () => {
    unrotate(turnedCCW, 270).forEach((v, i) => expect(v).toBeCloseTo(original[i], 9))
  })

  it('leaves an upright box alone', () => {
    expect(unrotate(original, 0)).toEqual(original)
  })
})
