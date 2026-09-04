import { describe, expect, it } from 'vitest'

// Core regex patterns matching public/content.js
const PATTERNS = {
  card: /\b(?:\d[ -]*?){13,19}\b/g,
  aadhaar: /\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b(?!\s?\d)/g,
  pan: /\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/g,
  voterId: /\b[A-Z]{3}[0-9]{7}\b/g,
  drivingLicense: /\b[A-Z]{2}[0-9]{2}[ -]?(?:19|20)[0-9]{2}[0-9]{7}\b|\b[A-Z]{2}[ -]?[0-9]{13,15}\b/g,
  gstin: /\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}\b/g,
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  phone: /\b(?:\+91[\s-]?)?[6-9]\d{9}\b/g,
  currency: /(?:₹|Rs\.?|INR|\$|€|£)\s?[\d,]+(?:\.\d{2})?\b/gi,
}

function sanitizeText(rawText: string) {
  let sanitized = rawText
  let count = 0
  const matchedTypes: string[] = []

  if (PATTERNS.currency.test(sanitized)) {
    sanitized = sanitized.replace(PATTERNS.currency, '[REDACTED_AMOUNT]')
    matchedTypes.push('Financial')
    count++
  }
  if (PATTERNS.drivingLicense.test(sanitized)) {
    sanitized = sanitized.replace(PATTERNS.drivingLicense, '[REDACTED_DRIVING_LICENSE]')
    matchedTypes.push('Driving License')
    count++
  }
  if (PATTERNS.gstin.test(sanitized)) {
    sanitized = sanitized.replace(PATTERNS.gstin, '[REDACTED_GSTIN]')
    matchedTypes.push('GSTIN')
    count++
  }
  if (PATTERNS.voterId.test(sanitized)) {
    sanitized = sanitized.replace(PATTERNS.voterId, '[REDACTED_VOTER_ID]')
    matchedTypes.push('Voter ID')
    count++
  }
  if (PATTERNS.pan.test(sanitized)) {
    sanitized = sanitized.replace(PATTERNS.pan, '[REDACTED_PAN]')
    matchedTypes.push('PAN')
    count++
  }
  if (PATTERNS.card.test(sanitized)) {
    sanitized = sanitized.replace(PATTERNS.card, '[REDACTED_CARD]')
    matchedTypes.push('Card')
    count++
  }
  if (PATTERNS.aadhaar.test(sanitized)) {
    sanitized = sanitized.replace(PATTERNS.aadhaar, '[REDACTED_AADHAAR]')
    matchedTypes.push('Aadhaar')
    count++
  }
  if (PATTERNS.email.test(sanitized)) {
    sanitized = sanitized.replace(PATTERNS.email, '[REDACTED_EMAIL]')
    matchedTypes.push('Email')
    count++
  }
  if (PATTERNS.phone.test(sanitized)) {
    sanitized = sanitized.replace(PATTERNS.phone, '[REDACTED_PHONE]')
    matchedTypes.push('Phone')
    count++
  }

  return { sanitized, count, matchedTypes }
}

describe('NetraShield Indian & Global PII Detection', () => {
  it('masks Indian Aadhaar numbers', () => {
    const input = 'User Aadhaar is 5489 1234 5678 for KYC'
    const res = sanitizeText(input)
    expect(res.sanitized).toContain('[REDACTED_AADHAAR]')
    expect(res.sanitized).not.toContain('5489 1234 5678')
    expect(res.matchedTypes).toContain('Aadhaar')
  })

  it('masks Indian PAN cards', () => {
    const input = 'Permanent Account Number: ABCDE1234F'
    const res = sanitizeText(input)
    expect(res.sanitized).toContain('[REDACTED_PAN]')
    expect(res.sanitized).not.toContain('ABCDE1234F')
    expect(res.matchedTypes).toContain('PAN')
  })

  it('masks Indian Voter ID (EPIC) numbers', () => {
    const input = 'Voter identity card number: WXJ1234567'
    const res = sanitizeText(input)
    expect(res.sanitized).toContain('[REDACTED_VOTER_ID]')
    expect(res.sanitized).not.toContain('WXJ1234567')
    expect(res.matchedTypes).toContain('Voter ID')
  })

  it('masks Indian Driving License numbers', () => {
    const input = 'License details DL-1420110012345 valid through 2030'
    const res = sanitizeText(input)
    expect(res.sanitized).toContain('[REDACTED_DRIVING_LICENSE]')
    expect(res.sanitized).not.toContain('DL-1420110012345')
    expect(res.matchedTypes).toContain('Driving License')
  })

  it('masks Indian GSTIN identification numbers', () => {
    const input = 'Invoice billed to GSTIN: 27AAAAA0000A1Z5 on goods sold'
    const res = sanitizeText(input)
    expect(res.sanitized).toContain('[REDACTED_GSTIN]')
    expect(res.sanitized).not.toContain('27AAAAA0000A1Z5')
    expect(res.matchedTypes).toContain('GSTIN')
  })

  it('masks email addresses and phone numbers', () => {
    const input = 'Contact user at secret.agent@isro.gov.in or call +91 9876543210'
    const res = sanitizeText(input)
    expect(res.sanitized).toContain('[REDACTED_EMAIL]')
    expect(res.sanitized).toContain('[REDACTED_PHONE]')
    expect(res.sanitized).not.toContain('secret.agent@isro.gov.in')
    expect(res.sanitized).not.toContain('9876543210')
  })

  it('masks financial card and currency amounts', () => {
    const input = 'Paid ₹45,000.00 using card 4111 2222 3333 4444'
    const res = sanitizeText(input)
    expect(res.sanitized).toContain('[REDACTED_AMOUNT]')
    expect(res.sanitized).toContain('[REDACTED_CARD]')
  })

  it('leaves benign non-sensitive text untouched', () => {
    const input = 'Click the blue Submit button on the checkout navigation bar'
    const res = sanitizeText(input)
    expect(res.sanitized).toBe(input)
    expect(res.count).toBe(0)
    expect(res.matchedTypes).toHaveLength(0)
  })
})
