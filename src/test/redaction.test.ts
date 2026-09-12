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

describe('checksum validators reduce false-positive PII classification', () => {
  // Grab the whole checksum block (both functions plus their shared Verhoeff
  // tables) in one slice, from luhnValid's declaration through verhoeffValid's
  // closing brace, and evaluate it as real code -- not a re-implementation.
  function loadChecksums(): { luhnValid: (raw: string) => boolean; verhoeffValid: (raw: string) => boolean } {
    const start = SOURCE.indexOf('function luhnValid(')
    const vStart = SOURCE.indexOf('function verhoeffValid(')
    expect(start).toBeGreaterThan(-1)
    expect(vStart).toBeGreaterThan(start)
    let depth = 0
    let end = vStart
    let started = false
    for (let i = vStart; i < SOURCE.length; i++) {
      if (SOURCE[i] === '{') { depth++; started = true }
      else if (SOURCE[i] === '}') { depth--; if (started && depth === 0) { end = i + 1; break } }
    }
    const body = SOURCE.slice(start, end)
    // eslint-disable-next-line no-new-func
    return new Function(`${body}; return { luhnValid, verhoeffValid };`)() as {
      luhnValid: (raw: string) => boolean
      verhoeffValid: (raw: string) => boolean
    }
  }

  it('luhnValid accepts a real Luhn-valid test card and rejects a mutated one', () => {
    const { luhnValid } = loadChecksums()
    expect(luhnValid('4111111111111111')).toBe(true)
    expect(luhnValid('4111111111111112')).toBe(false)
  })

  it('verhoeffValid accepts a real Verhoeff-valid 12-digit number and rejects a mutated one', () => {
    const { verhoeffValid } = loadChecksums()
    expect(verhoeffValid('234567890124')).toBe(true)
    expect(verhoeffValid('234567890123')).toBe(false)
  })

  it('records which redacted values also passed their checksum, without weakening the mask', () => {
    // Precision reporting only -- every match is still redacted regardless
    // of checksum result (see noteRedaction).
    expect(SOURCE).toContain('let redactionVerified = {}')
    expect(SOURCE).toContain("if (type === 'CARD') verified = luhnValid(match)")
    expect(SOURCE).toContain("else if (type === 'AADHAAR') verified = verhoeffValid(match)")
    expect(SOURCE).toContain('pii_verified: Object.fromEntries(')
  })
})

describe('numbered surrogate tokens (REDACT+TOKENIZE)', () => {
  // Loads the REAL redact() plus everything it closes over (patterns, state,
  // noteRedaction, surrogate) as one contiguous slice of the shipped source,
  // so this proves the actual shipped behaviour, not a re-implementation.
  function loadRedactor(): { redact: (t: string) => string } {
    const start = SOURCE.indexOf('const PII_PATTERNS = [')
    const fnStart = SOURCE.indexOf('function redact(text) {')
    expect(start).toBeGreaterThan(-1)
    expect(fnStart).toBeGreaterThan(start)
    let depth = 0
    let end = fnStart
    let started = false
    for (let i = fnStart; i < SOURCE.length; i++) {
      if (SOURCE[i] === '{') { depth++; started = true }
      else if (SOURCE[i] === '}') { depth--; if (started && depth === 0) { end = i + 1; break } }
    }
    const body = SOURCE.slice(start, end)
    // eslint-disable-next-line no-new-func
    return new Function(`${body}; return { redact };`)() as { redact: (t: string) => string }
  }

  it('gives the first distinct value in a type _01, the next distinct value _02', () => {
    const { redact } = loadRedactor()
    const out = redact('contact a@x.com or b@y.com')
    expect(out).toContain('[REDACTED:EMAIL_01]')
    expect(out).toContain('[REDACTED:EMAIL_02]')
  })

  it('reuses the same surrogate number when the same value repeats', () => {
    const { redact } = loadRedactor()
    const out = redact('email a@x.com again: a@x.com')
    expect(out.match(/\[REDACTED:EMAIL_\d+\]/g)).toEqual(['[REDACTED:EMAIL_01]', '[REDACTED:EMAIL_01]'])
  })

  it('numbers each PII type independently', () => {
    const { redact } = loadRedactor()
    const out = redact('card 4111 1111 1111 1111, email a@x.com')
    expect(out).toContain('[REDACTED:CARD_01]')
    expect(out).toContain('[REDACTED:EMAIL_01]')
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

/**
 * extract used to `continue` on any candidate without a price, which made it a
 * storefront scraper wearing a general verb's name. Because extraction is what
 * puts a value on the record for capability_gate, a page it could not read was
 * a page whose data could never be written anywhere else.
 */
describe('extraction reads any repeated list, not just priced cards', () => {
  it('falls back to a generic group when no priced group is found', () => {
    expect(SOURCE).toContain('collectRepeatedGroup(params, maxResults, true)')
    expect(SOURCE).toContain('collectRepeatedGroup(params, maxResults, false)')
  })

  it('only demands a price on the priced pass', () => {
    // The old bail-out was unconditional, which is the whole bug. It is still
    // there, but now it is reached only when requirePrice is set.
    expect(SOURCE).toContain('} else if (text.length < 8) continue')
    expect(SOURCE).toContain('if (requirePrice && !priceMatch) continue')
  })

  it('carries the whole row, not just a name and a price', () => {
    expect(SOURCE).toContain('text: redact(text).slice(0, 300)')
    expect(SOURCE).toContain('number: numberMatch ? Number(numberMatch[0]) : null')
  })

  it('does not call a bare decimal a rating outside a storefront', () => {
    // On an earthquake list "4.6" is the magnitude. Filing it as a rating puts
    // the right number in the wrong column.
    expect(SOURCE).toContain("(requirePrice ? text.match(/\\b([0-5]\\.\\d)\\b/) : null)")
  })

  it('scores data rows above nav bars instead of taking the biggest group', () => {
    expect(SOURCE).toContain('function scoreGroup(')
    expect(SOURCE).toContain('if (score <= 0) continue')
  })

  it('considers custom elements, not a hardcoded list of tag names', () => {
    // Angular / Web Component apps render rows as <mat-list-item> and the
    // like. A 'div, li, article, section, tr, a' whitelist matches none of
    // them, so the extractor would find nothing on exactly the applications
    // worth automating -- USGS's earthquake list among them.
    expect(SOURCE).toContain("document.querySelectorAll('*')")
    expect(SOURCE).toContain('NOT_A_ROW.has(el.tagName.toLowerCase())')
    expect(SOURCE).not.toContain("querySelectorAll('div, li, article, section, tr, a')")
  })

  it('bounds the scan so a huge application does not stall it', () => {
    expect(SOURCE).toContain('MAX_CANDIDATES')
  })
})

describe('paste_table writes a whole table into a canvas grid', () => {
  it('sends both TSV and an HTML table on the clipboard payload', () => {
    expect(SOURCE).toContain("dt.setData('text/plain', tsv)")
    expect(SOURCE).toContain("dt.setData('text/html', html)")
  })

  it('treats a cancelled paste as the proof it landed', () => {
    // A grid that takes a paste calls preventDefault, so dispatchEvent returns
    // false. There is no cell to read back, so this is the only honest signal.
    expect(SOURCE).toContain('const uncancelled = node.dispatchEvent(ev)')
    expect(SOURCE).toContain('if (!uncancelled) {')
  })

  it('reports failure rather than claiming a table it never wrote', () => {
    expect(SOURCE).toContain("error: 'no element on this page handled a paste event'")
  })

  it('is reachable as a page verb', () => {
    expect(SOURCE).toContain("case 'paste_table': {")
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

/**
 * The name detector used to be /\b[A-Z][a-z]{2,}\b/ running at `balanced`, the
 * default. That is not a name detector -- it matches the first word of almost
 * any interface label -- so every accessible name reached the reasoner with its
 * most identifying word replaced by a surrogate. The agent could not find a
 * search box called "Search", a send button called "Send", or a composer called
 * "Type a message", and the capability gate, reading the same mangled names,
 * mistook WhatsApp's contact search for a message field.
 */
describe('the NAME detector hides people, not the interface', () => {
  function namePattern(): RegExp {
    const block = SOURCE.split('const STRICTER_PATTERNS = [')[1].split('\n]')[0]
    const m = /\{\s*type:\s*'NAME',\s*regex:\s*(\/.+?\/[gimsuy]*),\s*from:\s*'(\w+)'/.exec(block)
    if (!m) throw new Error('no NAME pattern in STRICTER_PATTERNS')
    const body = m[1]
    const lastSlash = body.lastIndexOf('/')
    return new RegExp(body.slice(1, lastSlash), body.slice(lastSlash + 1))
  }

  function nameTier(): string {
    const block = SOURCE.split('const STRICTER_PATTERNS = [')[1].split('\n]')[0]
    const m = /type:\s*'NAME',[\s\S]*?from:\s*'(\w+)'/.exec(block)
    return m ? m[1] : ''
  }

  it('is a strict-tier pattern, as the module comment has always claimed', () => {
    expect(nameTier()).toBe('strict')
  })

  const LABELS = [
    'Search or start new chat',
    'Search input textbox',
    'Type a message',
    'Send',
    'Chat list',
    'New chat',
    'Voice message',
    'Archived',
  ]

  function uiVocabulary(): Set<string> {
    const block = SOURCE.split('const UI_VOCABULARY = new Set((')[1].split(').split(')[0]
    const words = (block.match(/'([^']*)'/g) || [])
      .map((chunk) => chunk.slice(1, -1))
      .join(' ')
    return new Set(words.split(/\s+/).filter(Boolean))
  }

  /** The shipped redaction path for NAME: pattern, then the chrome guard. */
  function redactNames(text: string): string {
    const re = namePattern()
    const vocab = uiVocabulary()
    re.lastIndex = 0
    return text.replace(re, (match) => {
      const tokens = match.toLowerCase().split(/[^a-z]+/).filter(Boolean)
      if (!tokens.length || tokens.some((t) => vocab.has(t))) return match
      return '[REDACTED:NAME_01]'
    })
  }

  it.each(LABELS)('leaves the control label %j intact', (label) => {
    expect(redactNames(label)).toBe(label)
  })

  it('still hides a real full name', () => {
    expect(redactNames('Harsh Dubey')).toBe('[REDACTED:NAME_01]')
    expect(redactNames('call Gaurav Kaushal back')).toBe('call [REDACTED:NAME_01] back')
  })

  it('ships the UI-vocabulary guard that keeps control labels readable', () => {
    expect(SOURCE).toContain('const UI_VOCABULARY')
    expect(SOURCE).toContain("if (p.type === 'NAME' && looksLikeUiChrome(match)) return match")
  })
})
