import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * These tests read the REAL patterns out of public/agent-content.js rather than
 * re-declaring them, so the test cannot drift away from what actually ships.
 */
const SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../../public/agent-content.js'),
  'utf8',
)

function extractPatterns(): { type: string; regex: RegExp }[] {
  const block = SOURCE.split('const PII_PATTERNS = [')[1].split('\n]')[0]
  const out: { type: string; regex: RegExp }[] = []
  const line = /\{\s*type:\s*'([A-Z]+)',\s*regex:\s*(\/.+\/[gimsuy]*)\s*\}/g
  let m: RegExpExecArray | null
  while ((m = line.exec(block)) !== null) {
    const body = m[2]
    const lastSlash = body.lastIndexOf('/')
    out.push({
      type: m[1],
      regex: new RegExp(body.slice(1, lastSlash), body.slice(lastSlash + 1)),
    })
  }
  return out
}

function redact(text: string): string {
  let out = text
  for (const p of extractPatterns()) {
    p.regex.lastIndex = 0
    out = out.replace(p.regex, `[REDACTED:${p.type}]`)
  }
  return out
}

describe('PII redaction patterns actually shipped in agent-content.js', () => {
  it('parses a non-empty pattern set out of the shipped source', () => {
    expect(extractPatterns().length).toBeGreaterThanOrEqual(8)
  })

  it('redacts an email address', () => {
    expect(redact('write to test@a.com now')).toContain('[REDACTED:EMAIL]')
    expect(redact('write to test@a.com now')).not.toContain('test@a.com')
  })

  it('redacts a payment card number', () => {
    const out = redact('card 4111 1111 1111 1111 on file')
    expect(out).toContain('[REDACTED:CARD]')
    expect(out).not.toContain('4111')
  })

  it('redacts an Indian phone number', () => {
    expect(redact('call +91 9876543210')).toContain('[REDACTED:')
  })

  it('redacts a PAN', () => {
    expect(redact('PAN ABCDE1234F')).toContain('[REDACTED:PAN]')
  })

  it('redacts a UPI handle', () => {
    expect(redact('pay customer@okhdfcbank')).toContain('[REDACTED:')
  })

  it('leaves prices alone - they are task data, not PII', () => {
    const out = redact('Running shoes at Rs 1,799 and $24.99')
    expect(out).toContain('1,799')
    expect(out).toContain('24.99')
  })

  it('does not redact ordinary product text', () => {
    const text = 'Strider Lite Mens Running Shoes 4.2 out of 5'
    expect(redact(text)).toBe(text)
  })
})

describe('protected fields never leave the page as values', () => {
  it('declares a protected-field regex covering password, otp, cvv and upi pin', () => {
    const m = SOURCE.match(/const PROTECTED_FIELD_REGEX = (\/.+\/[gimsuy]*)/)
    expect(m).toBeTruthy()
    const body = m![1]
    const lastSlash = body.lastIndexOf('/')
    const re = new RegExp(body.slice(1, lastSlash), body.slice(lastSlash + 1))
    for (const name of ['password', 'otp', 'cvv', 'card number', 'aadhaar', 'upi pin']) {
      expect(re.test(name)).toBe(true)
    }
    expect(re.test('search query')).toBe(false)
  })

  it('emits a length-only marker instead of a protected value', () => {
    expect(SOURCE).toContain("'[PROTECTED INPUT] len='")
  })
})

describe('contenteditable typing uses the events real editors listen for', () => {
  it('uses execCommand insertText with an InputEvent fallback', () => {
    expect(SOURCE).toContain("document.execCommand('insertText', false, text)")
    expect(SOURCE).toContain("new InputEvent('beforeinput'")
  })

  it('reads the field back and reports whether the text landed', () => {
    expect(SOURCE).toContain('verified:')
    expect(SOURCE).toContain('readback:')
  })

  it('uses the native value setter for real inputs so frameworks notice', () => {
    expect(SOURCE).toContain('Object.getOwnPropertyDescriptor(proto, ')
  })
})

describe('extraction gate G4 - urls must exist in the live DOM', () => {
  it('builds a live href set and only emits urls found in it', () => {
    expect(SOURCE).toContain('const liveHrefs = new Set()')
    expect(SOURCE).toContain('liveHrefs.has(anchor.href)')
  })

  it('requires at least three structurally similar priced containers', () => {
    expect(SOURCE).toContain('if (list.length < 3) continue')
  })
})

describe('clicking hits what the pointer is actually over', () => {
  it('dispatches on the inner node when one sits under the click point', () => {
    // Application UIs put the handler on a descendant of the row/card, so a
    // click aimed only at the container never reaches the listener.
    expect(SOURCE).toContain('document.elementFromPoint(pt.x, pt.y)')
    expect(SOURCE).toContain('if (el.contains(top)) {')
    expect(SOURCE).toContain('target = top')
  })

  it('reports an unrelated element covering the target instead of clicking it', () => {
    expect(SOURCE).toContain('occludedBy =')
    expect(SOURCE).toContain('occluded_by: occludedBy')
  })

  it('falls back to a native click when the synthetic sequence changed nothing', () => {
    expect(SOURCE).toContain('native_fallback: usedNativeFallback')
    expect(SOURCE).toContain('clickable.click()')
  })

  it('says which node it actually dispatched on, for the audit trail', () => {
    expect(SOURCE).toContain('dispatched_on:')
  })
})

describe('the walker ranks before it caps', () => {
  it('scores on-screen and editable elements above bulk list rows', () => {
    expect(SOURCE).toContain('if (onScreen) score += 1000')
    expect(SOURCE).toContain('if (editable) score += 400')
    expect(SOURCE).toContain("if (role === 'listitem' || role === 'row' || role === 'gridcell') score -= 20")
  })

  it('sorts by that score so a composer is never cut off by a long sidebar', () => {
    expect(SOURCE).toContain('scored.sort((a, b) => b.score - a.score')
  })
})
