export type PrivacyMode = 'strict' | 'balanced' | 'fast'
export type ScanStatus = 'idle' | 'scanning' | 'ready' | 'error'
export type ReasonStatus = 'idle' | 'thinking' | 'ready' | 'error'

export type ReasoningEngine = 'auto' | 'onnx' | 'server'

export type SummaryLanguage = 'en' | 'hi' | 'hinglish'

export type UserSettings = {
  reasoningEngine: ReasoningEngine
  serverUrl: string
  privacyMode: PrivacyMode
  summaryLanguage?: SummaryLanguage
}

export type SensitiveRegion = {
  id: string
  label: string
  type: string
  confidence: number
  source: string
  box: [number, number, number, number]
}

export type PageElement = {
  id: string
  role: string
  label: string
  box: [number, number, number, number]
  masked: boolean
}

export type SanitizedPayload = {
  schemaVersion: string
  mode: PrivacyMode
  page: {
    origin: string
    titleHint: string
  }
  privacySummary: {
    regionCount: number
    redactionTypes: Record<string, number>
    coverage: number
  }
  pageText?: string
  visualSummary: {
    visualDensity: string
    model: string
    elementCounts: {
      buttons: number
      fields: number
      links: number
      total: number
    }
  }
  elements: PageElement[]
  redactions: Array<{
    id: string
    type: string
    confidence: number
    box: [number, number, number, number]
  }>
}

export type AgentRequestPayload = SanitizedPayload & {
  task: string
  screenshot?: string
  pageText?: string
  lang?: SummaryLanguage
}

export type ScanResult = {
  url: string
  title: string
  regions: SensitiveRegion[]
  elements: PageElement[]
  payload: SanitizedPayload
  timings: {
    domMs: number
    redactionMs: number
    totalMs: number
  }
}

export type AgentCommand = {
  type: 'highlight' | 'none'
  targetId: string
  instruction: string
}

export type ReasonResult = {
  ok: boolean
  source: 'server' | 'extension-fallback' | 'local-onnx'
  command: AgentCommand
  rationale?: string
  error?: string
}
