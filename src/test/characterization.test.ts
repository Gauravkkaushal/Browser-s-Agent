import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const CONTENT_SCRIPT_PATH = path.resolve(__dirname, '../../public/agent-content.js')
const SOURCE = fs.readFileSync(CONTENT_SCRIPT_PATH, 'utf8')

// Parse shipped core PII patterns directly from agent-content.js
function extractCorePatterns(): { type: string; regex: RegExp }[] {
  const piiBlock = SOURCE.split('const PII_PATTERNS = [')[1].split('\n]')[0]

  const out: { type: string; regex: RegExp }[] = []
  const lineRegex = /\{\s*type:\s*'([A-Z_]+)',\s*regex:\s*(\/.+\/[gimsuy]*)/g
  let m: RegExpExecArray | null
  while ((m = lineRegex.exec(piiBlock)) !== null) {
    const body = m[2]
    const lastSlash = body.lastIndexOf('/')
    out.push({
      type: m[1],
      regex: new RegExp(body.slice(1, lastSlash), body.slice(lastSlash + 1)),
    })
  }
  return out
}

function extractStricterPatterns(): { type: string; regex: RegExp }[] {
  const stricterBlock = SOURCE.split('const STRICTER_PATTERNS = [')[1].split('\n]')[0]
  const out: { type: string; regex: RegExp }[] = []
  const lineRegex = /\{\s*type:\s*'([A-Z_]+)',\s*regex:\s*(\/.+\/[gimsuy]*)/g
  let m: RegExpExecArray | null
  while ((m = lineRegex.exec(stricterBlock)) !== null) {
    const body = m[2]
    const lastSlash = body.lastIndexOf('/')
    out.push({
      type: m[1],
      regex: new RegExp(body.slice(1, lastSlash), body.slice(lastSlash + 1)),
    })
  }
  return out
}

function loadChecksums(): { luhnValid: (raw: string) => boolean; verhoeffValid: (raw: string) => boolean } {
  const start = SOURCE.indexOf('function luhnValid(')
  const vStart = SOURCE.indexOf('function verhoeffValid(')
  let depth = 0
  let end = vStart
  let started = false
  for (let i = vStart; i < SOURCE.length; i++) {
    if (SOURCE[i] === '{') {
      depth++
      started = true
    } else if (SOURCE[i] === '}') {
      depth--
      if (started && depth === 0) {
        end = i + 1
        break
      }
    }
  }
  const body = SOURCE.slice(start, end)
  const fn = new Function(`${body}; return { luhnValid, verhoeffValid };`)
  return fn() as {
    luhnValid: (raw: string) => boolean
    verhoeffValid: (raw: string) => boolean
  }
}

function redactText(text: string, patterns = [...extractCorePatterns(), ...extractStricterPatterns()]): string {
  let out = text
  for (const p of patterns) {
    p.regex.lastIndex = 0
    out = out.replace(p.regex, `[REDACTED:${p.type}]`)
  }
  return out
}

describe('Safety Net: Characterization Tests for Perception, Detectors & Pipeline', () => {
  const corePatterns = extractCorePatterns()
  const stricterPatterns = extractStricterPatterns()
  const allPatterns = [...corePatterns, ...stricterPatterns]
  const { luhnValid, verhoeffValid } = loadChecksums()

  describe('1. Individual PII Detectors', () => {
    it('detects and redacts Email addresses with varying TLDs and cases', () => {
      const emailPattern = corePatterns.find((p) => p.type === 'EMAIL')
      expect(emailPattern).toBeDefined()
      const samples = [
        'test.user+tag@gmail.com',
        'OFFICE@GOV.IN',
        'citizen_help@isro.gov.in',
      ]
      for (const sample of samples) {
        emailPattern!.regex.lastIndex = 0
        expect(emailPattern!.regex.test(sample), `Failed for ${sample}`).toBe(true)
        expect(redactText(sample, [emailPattern!])).toContain('[REDACTED:EMAIL]')
      }
    })

    it('detects and redacts Indian Mobile numbers with and without prefix', () => {
      const phonePattern = corePatterns.find((p) => p.type === 'PHONE')
      expect(phonePattern).toBeDefined()
      const samples = [
        '+91 9876543210',
        '+91-9123456789',
        '9876543210',
        '+91 88888 88888',
      ]
      for (const sample of samples) {
        phonePattern!.regex.lastIndex = 0
        expect(phonePattern!.regex.test(sample), `Failed for ${sample}`).toBe(true)
        expect(redactText(sample, [phonePattern!])).toContain('[REDACTED:PHONE]')
      }
    })

    it('detects and validates Payment Cards via Luhn checksum', () => {
      const cardPattern = corePatterns.find((p) => p.type === 'CARD')
      expect(cardPattern).toBeDefined()
      const validCard = '4111 1111 1111 1111'
      const invalidCard = '4111 1111 1111 1112'

      cardPattern!.regex.lastIndex = 0
      expect(cardPattern!.regex.test(validCard)).toBe(true)
      expect(luhnValid(validCard)).toBe(true)
      expect(luhnValid(invalidCard)).toBe(false)
      expect(redactText(validCard, [cardPattern!])).toContain('[REDACTED:CARD]')
    })

    it('detects and validates Indian Aadhaar numbers with Verhoeff checksum', () => {
      const aadhaarPattern = corePatterns.find((p) => p.type === 'AADHAAR')
      expect(aadhaarPattern).toBeDefined()
      const validAadhaar = '9876 5432 1096'
      const invalidAadhaar = '9876 5432 1097'

      aadhaarPattern!.regex.lastIndex = 0
      expect(aadhaarPattern!.regex.test(validAadhaar)).toBe(true)
      expect(verhoeffValid(validAadhaar.replace(/\s+/g, ''))).toBe(true)
      expect(verhoeffValid(invalidAadhaar.replace(/\s+/g, ''))).toBe(false)
      expect(redactText(validAadhaar, [aadhaarPattern!])).toContain('[REDACTED:AADHAAR]')
    })

    it('detects and redacts Indian PAN format', () => {
      const panPattern = corePatterns.find((p) => p.type === 'PAN')
      expect(panPattern).toBeDefined()
      const validPan = 'ABCDE1234F'
      panPattern!.regex.lastIndex = 0
      expect(panPattern!.regex.test(validPan)).toBe(true)
      expect(redactText(validPan, [panPattern!])).toContain('[REDACTED:PAN]')
    })

    it('detects and redacts UPI Virtual Payment Addresses', () => {
      const upiPattern = corePatterns.find((p) => p.type === 'UPI')
      expect(upiPattern).toBeDefined()
      const upiSamples = [
        'merchant@okhdfcbank',
        'citizen@oksbi',
        'payment@paytm',
        'billpay@upi',
      ]
      for (const sample of upiSamples) {
        upiPattern!.regex.lastIndex = 0
        expect(upiPattern!.regex.test(sample), `Failed for ${sample}`).toBe(true)
        expect(redactText(sample, [upiPattern!])).toContain('[REDACTED:UPI]')
      }
    })

    it('detects Date of Birth patterns from stricter patterns', () => {
      const dobPattern = stricterPatterns.find((p) => p.type === 'DOB')
      expect(dobPattern).toBeDefined()
      const sample = 'DOB: 15/08/1995'
      dobPattern!.regex.lastIndex = 0
      expect(dobPattern!.regex.test(sample)).toBe(true)
      expect(redactText(sample, [dobPattern!])).toContain('[REDACTED:DOB]')
    })
  })

  describe('2. Non-PII & Task Preservation', () => {
    it('strictly preserves item prices and numbers', () => {
      const priceText = 'Order total: ₹1,499.00 or $29.99 for 2 items'
      const redacted = redactText(priceText, corePatterns)
      expect(redacted).toContain('1,499.00')
      expect(redacted).toContain('29.99')
      expect(redacted).not.toContain('[REDACTED:')
    })

    it('preserves user navigation instructions and UI labels', () => {
      const uiText = 'Click the button to proceed to payment confirmation'
      expect(redactText(uiText, corePatterns)).toBe(uiText)
    })
  })

  describe('3. Protected Fields Detection Contract', () => {
    it('identifies credential and secret fields by attributes', () => {
      const regexMatch = SOURCE.match(/const PROTECTED_FIELD_REGEX = (\/.+\/[gimsuy]*)/)
      expect(regexMatch).not.toBeNull()
      const regexBody = regexMatch![1]
      const lastSlash = regexBody.lastIndexOf('/')
      const protectedRegex = new RegExp(regexBody.slice(1, lastSlash), regexBody.slice(lastSlash + 1))

      const sensitiveAttributes = [
        'password',
        'passwd',
        'pin',
        'upi pin',
        'security_token',
        'otp',
        'card_cvv',
        'cvc',
      ]
      for (const attr of sensitiveAttributes) {
        expect(protectedRegex.test(attr), `Expected ${attr} to be protected`).toBe(true)
      }

      const harmlessAttributes = ['search_query', 'username_email', 'first_name', 'postal_address']
      for (const attr of harmlessAttributes) {
        expect(protectedRegex.test(attr), `Expected ${attr} not to match protectedRegex`).toBe(false)
      }
    })
  })

  describe('4. Golden Benchmark Fixture Verification', () => {
    it('verifies all labeled PII in golden_pii_page.html are redacted', () => {
      const htmlPath = path.resolve(__dirname, 'fixtures/golden_pii_page.html')
      const jsonPath = path.resolve(__dirname, 'fixtures/golden_pii_expectations.json')
      expect(fs.existsSync(htmlPath)).toBe(true)
      expect(fs.existsSync(jsonPath)).toBe(true)

      const html = fs.readFileSync(htmlPath, 'utf8')
      const expectations = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))

      const redactedHtml = redactText(html, allPatterns)

      for (const entity of expectations.entities) {
        if (entity.raw_value) {
          expect(
            redactedHtml,
            `Expected ${entity.expected_type} value ${entity.raw_value} to be absent from redacted output`,
          ).not.toContain(entity.raw_value)
        }
      }

      for (const text of expectations.preserved_non_pii) {
        // Price values must be preserved even under all redactions
        if (text.includes('Rs') || text.includes('$')) {
          expect(redactedHtml, `Expected preserved price '${text}' to remain present`).toContain(text)
        }
      }
    })
  })
})

