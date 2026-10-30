import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Faces and contact names are found by STRUCTURE: a small round picture, and
 * the first name-like line beside it. These tests run the real shipped helpers.
 */
const SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../../public/agent-content.js'),
  'utf8',
)

function slice(from: string, to: string): string {
  const start = SOURCE.indexOf(from)
  const end = SOURCE.indexOf(to)
  if (start < 0 || end < start) throw new Error(`could not find ${from} in agent-content.js`)
  return SOURCE.slice(start, end)
}

const helpers = new Function(
  `${slice('const UI_VOCABULARY', 'function looksLikeUiChrome')}
   ${slice('const AVATAR_MIN_PX', 'function findAvatars(')}
   return { isAvatarShape, nameFromCardText }`,
)() as {
  isAvatarShape: (w: number, h: number, radii: string[]) => boolean
  nameFromCardText: (text: string) => string
}

describe('always-on redaction ignores its own masks', () => {
  const root = { tag: 'html' }
  const own = (extra = {}) => ({ nodeType: 1, closest: () => ({}), ...extra })
  const page = { nodeType: 1, closest: () => null }
  const { onlyOwnMutations } = new Function(
    'document',
    `${slice('function isOwnNode', 'let autoRedactTimer')}; return { onlyOwnMutations }`,
  )({ documentElement: root }) as { onlyOwnMutations: (r: any[]) => boolean }

  it('does not re-scan when only a mask was added, removed or relabelled', () => {
    expect(onlyOwnMutations([{ target: root, addedNodes: [own()], removedNodes: [] }])).toBe(true)
    expect(onlyOwnMutations([{ target: own(), addedNodes: [], removedNodes: [] }])).toBe(true)
  })

  it('re-scans when the page itself changed', () => {
    expect(onlyOwnMutations([{ target: page, addedNodes: [page], removedNodes: [] }])).toBe(false)
    expect(onlyOwnMutations([
      { target: root, addedNodes: [own()], removedNodes: [] },
      { target: page, addedNodes: [], removedNodes: [] },
    ])).toBe(false)
  })
})

describe('OCR words become lines before the PII check', () => {
  const { ocrLines } = new Function(
    `${slice('function ocrLines', '// Pictures big enough')}; return { ocrLines }`,
  )() as { ocrLines: (w: any[]) => { text: string; box: number[] }[] }

  it('joins a name split into words, and keeps separate lines apart', () => {
    const lines = ocrLines([
      { text: 'VERMA,', box: [120, 100, 60, 20] },
      { text: 'Dear', box: [0, 101, 40, 20] },
      { text: 'NAMAN', box: [50, 99, 60, 20] },
      { text: 'This', box: [0, 140, 40, 20] },
    ])
    expect(lines.map((l) => l.text)).toEqual(['Dear NAMAN VERMA,', 'This'])
    expect(lines[0].box).toEqual([0, 99, 180, 22])
  })

  it('reads an ID card the way a person would', () => {
    const { ocrOnlyKind } = new Function(
      `${slice('const CARD_WORDS', 'async function urlToDataUrl')}; return { ocrOnlyKind }`,
    )() as { ocrOnlyKind: (t: string) => string }
    expect(ocrOnlyKind('RAHUL KUMAR')).toBe('NAME')
    expect(ocrOnlyKind('0000 1111 2222')).toBe('AADHAAR')
    expect(ocrOnlyKind('GOVERNMENT OF INDIA')).toBe('')
    expect(ocrOnlyKind('Gender: MALE')).toBe('')
    // What OCR really returns from the full-size card and a college ID.
    expect(ocrOnlyKind('| RAHUL KUMAR')).toBe('NAME')
    expect(ocrOnlyKind('S/O MAHENDRA PAL')).toBe('NAME')
    expect(ocrOnlyKind('2428CS1673')).toBe('ID')
    expect(ocrOnlyKind('DOB: 15-08-1994')).toBe('')
    expect(ocrOnlyKind('2024-2028')).toBe('')
  })

  it('a greeting line read off a picture is a name', () => {
    const p = /\b(?:Dear|Hi|Hello|Hey|Attn\.?)\s+(?:(?:Mr|Mrs|Ms|Dr)\.?\s+)?[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3}/g
    expect(SOURCE).toContain(String(p))
    expect('Dear NAMAN VERMA,'.replace(p, '[X]')).toBe('[X],')
  })
})

describe('masks land on the picture, not on the letterbox around it', () => {
  const shownImageBox = new Function('window',
    `${slice('function shownImageBox', 'async function urlToDataUrl')}; return shownImageBox`,
  )({ getComputedStyle: (el: any) => ({ objectFit: el.fit }) }) as
    (el: any, r: any) => { dx: number; dy: number; width: number; height: number }
  const img = (fit: string) => ({ tagName: 'IMG', naturalWidth: 1000, naturalHeight: 1400, fit })

  it('a document letterboxed into a wide viewer sits in the middle', () => {
    expect(shownImageBox(img('contain'), { width: 1900, height: 950 }))
      .toEqual({ dx: (1900 - 1000 * (950 / 1400)) / 2, dy: 0, width: 1000 * (950 / 1400), height: 950 })
  })

  it('a plain image fills its box', () => {
    expect(shownImageBox(img('fill'), { width: 300, height: 200 })).toEqual({ dx: 0, dy: 0, width: 300, height: 200 })
  })
})

describe('avatar detection', () => {
  it('accepts a round profile picture, clipped by its parent', () => {
    expect(helpers.isAvatarShape(49, 49, ['0px', '50%'])).toBe(true)
    expect(helpers.isAvatarShape(40, 40, ['20px'])).toBe(true)
  })

  it('rejects logos, product shots and banners', () => {
    expect(helpers.isAvatarShape(40, 40, ['4px', '0px'])).toBe(false) // square logo
    expect(helpers.isAvatarShape(200, 200, ['50%'])).toBe(false) // big photo
    expect(helpers.isAvatarShape(80, 40, ['50%'])).toBe(false) // not square
  })
})

describe('contact name beside an avatar', () => {
  it.each([
    ['N I K H I L\n12:15 am\nhttps://www.canva.com/design', 'N I K H I L'],
    ['CS 5C Unofficial\nYesterday\n~MAN$I VERMA: Sab dept mai chutti', 'CS 5C Unofficial'],
    ['Yesterday\nRahul\nyou are so good', 'Rahul'],
    ['10:57 pm\n58', ''],
  ])('reads %j as %j', (text, name) => {
    expect(helpers.nameFromCardText(text)).toBe(name)
  })

  it('hides a group sender written as ~Name:', () => {
    const p = /~\s?[^:\n~]{2,40}(?=:)/g
    expect(SOURCE).toContain(String(p))
    expect('~MAN$I VERMA: Sab dept'.replace(p, '[X]')).toBe('[X]: Sab dept')
  })

  it('skips interface words', () => {
    expect(helpers.nameFromCardText('Archived\nSearch')).toBe('')
  })
})
