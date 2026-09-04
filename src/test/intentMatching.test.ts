import { describe, expect, it } from 'vitest'
import vocabMeta from '../shared/lib/modelVocab.json'

// Simulated DOM elements
const mockElements = [
  { id: 'el-login', role: 'button', label: 'Sign In with SSO', box: [10, 10, 80, 30] as [number, number, number, number], masked: false },
  { id: 'el-pay', role: 'button', label: 'Proceed to Pay & Checkout', box: [50, 10, 100, 30] as [number, number, number, number], masked: false },
  { id: 'el-save', role: 'button', label: 'Save Changes & Submit', box: [90, 10, 100, 30] as [number, number, number, number], masked: false },
  { id: 'el-send', role: 'button', label: 'Send Message / Dispatch', box: [130, 10, 100, 30] as [number, number, number, number], masked: false },
  { id: 'el-search', role: 'button', label: 'Search and Filter Records', box: [170, 10, 100, 30] as [number, number, number, number], masked: false },
  { id: 'el-delete', role: 'button', label: 'Delete Account and Discard', box: [210, 10, 100, 30] as [number, number, number, number], masked: false },
  { id: 'el-nav', role: 'link', label: 'Navigate Home Menu', box: [250, 10, 80, 30] as [number, number, number, number], masked: false },
  { id: 'el-dl', role: 'button', label: 'Download and Export CSV', box: [290, 10, 100, 30] as [number, number, number, number], masked: false },
]

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

function matchIntent(intent: string) {
  const targetKeywords = intentKeywords[intent] || ['submit', 'button']
  let bestElement = mockElements[0]
  let bestScore = -1

  for (const el of mockElements) {
    let score = 0
    const text = `${el.label || ''} ${el.role || ''} ${el.id || ''}`.toLowerCase()
    for (const kw of targetKeywords) {
      if (text.includes(kw)) score += 3
    }
    if (el.role === 'button' || el.role === 'link') score += 1
    if (score > bestScore) {
      bestScore = score
      bestElement = el
    }
  }

  return bestElement
}

describe('NetraShield 8-Class Intent Element Mapping', () => {
  it('covers all 8 classes in vocab metadata', () => {
    expect(vocabMeta.classes).toHaveLength(8)
  })

  it('correctly maps delete intent to delete element', () => {
    const matched = matchIntent('delete')
    expect(matched.id).toBe('el-delete')
    expect(matched.label).toContain('Delete')
  })

  it('correctly maps navigate intent to navigation element', () => {
    const matched = matchIntent('navigate')
    expect(matched.id).toBe('el-nav')
    expect(matched.label).toContain('Navigate')
  })

  it('correctly maps download intent to download/export element', () => {
    const matched = matchIntent('download')
    expect(matched.id).toBe('el-dl')
    expect(matched.label).toContain('Download')
  })

  it('correctly maps pay intent to pay/checkout element', () => {
    const matched = matchIntent('pay')
    expect(matched.id).toBe('el-pay')
  })

  it('correctly maps login intent to sign-in element', () => {
    const matched = matchIntent('login')
    expect(matched.id).toBe('el-login')
  })

  it('correctly maps search intent to search element', () => {
    const matched = matchIntent('search')
    expect(matched.id).toBe('el-search')
  })
})
