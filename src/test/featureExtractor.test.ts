import { describe, expect, it } from 'vitest'
import { extractFeatures } from '../shared/lib/onnxInference'
import type { SanitizedPayload } from '../shared/types/netrashield'
import vocabMeta from '../shared/lib/modelVocab.json'

const mockPayload: SanitizedPayload = {
  schemaVersion: '1.0.0',
  mode: 'strict',
  page: {
    origin: 'https://demo.isro.gov.in',
    titleHint: 'Portal',
  },
  privacySummary: {
    regionCount: 1,
    redactionTypes: { PAN: 1 },
    coverage: 1,
  },
  elements: [
    { id: 'btn-delete', role: 'button', label: 'Delete Record', box: [0, 0, 100, 30], masked: false },
    { id: 'btn-nav', role: 'link', label: 'Navigate Home', box: [40, 0, 80, 30], masked: false },
    { id: 'btn-dl', role: 'button', label: 'Download File Export', box: [80, 0, 100, 30], masked: false },
  ],
  redactions: [],
  visualSummary: {
    visualDensity: 'compact',
    model: 'v1',
    elementCounts: { buttons: 2, fields: 0, links: 1, total: 3 },
  },
}

describe('NetraShield ONNX Feature Extraction & Vocabulary', () => {
  it('has 90 vocabulary tokens and 8 target classes', () => {
    expect(vocabMeta.vocabulary).toHaveLength(90)
    expect(vocabMeta.classes).toEqual([
      'login',
      'pay',
      'save',
      'send',
      'search',
      'delete',
      'navigate',
      'download',
    ])
  })

  it('produces a Float32Array of exact length 90', () => {
    const vector = extractFeatures('delete the user record', mockPayload)
    expect(vector).toBeInstanceOf(Float32Array)
    expect(vector.length).toBe(90)
  })

  it('activates delete intent tokens when requested', () => {
    const vector = extractFeatures('please delete and remove this account', mockPayload)
    const deleteIdx = vocabMeta.vocabulary.indexOf('delete')
    const removeIdx = vocabMeta.vocabulary.indexOf('remove')
    expect(deleteIdx).toBeGreaterThanOrEqual(0)
    expect(removeIdx).toBeGreaterThanOrEqual(0)
    expect(vector[deleteIdx]).toBeGreaterThan(0)
    expect(vector[removeIdx]).toBeGreaterThan(0)
  })

  it('activates navigate intent tokens when requested', () => {
    const vector = extractFeatures('navigate back to home page', mockPayload)
    const navIdx = vocabMeta.vocabulary.indexOf('navigate')
    const homeIdx = vocabMeta.vocabulary.indexOf('home')
    expect(vector[navIdx]).toBeGreaterThan(0)
    expect(vector[homeIdx]).toBeGreaterThan(0)
  })

  it('activates download intent tokens when requested', () => {
    const vector = extractFeatures('download and export the report', mockPayload)
    const dlIdx = vocabMeta.vocabulary.indexOf('download')
    const exportIdx = vocabMeta.vocabulary.indexOf('export')
    expect(vector[dlIdx]).toBeGreaterThan(0)
    expect(vector[exportIdx]).toBeGreaterThan(0)
  })

  it('normalizes the feature vector to L2 unit norm', () => {
    const vector = extractFeatures('pay bill with card checkout', mockPayload)
    let sumSq = 0
    for (let i = 0; i < vector.length; i++) {
      sumSq += vector[i] * vector[i]
    }
    expect(Math.sqrt(sumSq)).toBeCloseTo(1.0, 4)
  })
})
