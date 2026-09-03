import { useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type PrivacyMode = 'strict' | 'balanced' | 'fast'
type ScanStatus = 'idle' | 'scanning' | 'ready' | 'error'
type ReasonStatus = 'idle' | 'thinking' | 'ready' | 'error'

type SensitiveRegion = {
  id: string
  label: string
  type: string
  confidence: number
  source: string
  box: [number, number, number, number]
}

type PageElement = {
  id: string
  role: string
  label: string
  box: [number, number, number, number]
  masked: boolean
}

type SanitizedPayload = {
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
  elements: PageElement[]
  redactions: Array<{
    id: string
    type: string
    confidence: number
    box: [number, number, number, number]
  }>
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
}

type AgentRequestPayload = SanitizedPayload & {
  task: string
}

type ScanResult = {
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

type AgentCommand = {
  type: 'highlight' | 'none'
  targetId: string
  instruction: string
}

type ReasonResult = {
  ok: boolean
  source: 'server' | 'extension-fallback'
  command: AgentCommand
  rationale?: string
  error?: string
}

type ChromeTab = {
  id?: number
}

type ChromeApi = {
  runtime: {
    lastError?: { message?: string }
    sendMessage: (
      message: { type: 'NETRASHIELD_REASON'; payload: AgentRequestPayload },
      callback: (response?: ReasonResult) => void,
    ) => void
  }
  tabs: {
    query: (
      queryInfo: { active: boolean; currentWindow: boolean },
      callback: (tabs: ChromeTab[]) => void,
    ) => void
    sendMessage: (
      tabId: number,
      message:
        | { type: 'NETRASHIELD_SCAN' | 'NETRASHIELD_APPLY_MASKS' | 'NETRASHIELD_CLEAR_MASKS'; mode?: PrivacyMode }
        | { type: 'NETRASHIELD_EXECUTE_COMMAND'; mode?: PrivacyMode; command: AgentCommand },
      callback: (response?: ScanResult | { ok: boolean }) => void,
    ) => void
  }
}

declare const chrome: ChromeApi | undefined

function App() {
  const [mode, setMode] = useState<PrivacyMode>('balanced')
  const [status, setStatus] = useState<ScanStatus>('idle')
  const [reasonStatus, setReasonStatus] = useState<ReasonStatus>('idle')
  const [error, setError] = useState('')
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [reason, setReason] = useState<ReasonResult | null>(null)
  const [task, setTask] = useState('')

  const extensionReady = typeof chrome !== 'undefined' && Boolean(chrome.tabs)

  async function sendToActiveTab(
    message:
      | { type: 'NETRASHIELD_SCAN' | 'NETRASHIELD_APPLY_MASKS' | 'NETRASHIELD_CLEAR_MASKS'; mode?: PrivacyMode }
      | { type: 'NETRASHIELD_EXECUTE_COMMAND'; mode?: PrivacyMode; command: AgentCommand },
  ) {
    if (!extensionReady) {
      throw new Error('Build the app and load the dist folder as an unpacked Chrome extension.')
    }

    return new Promise<ScanResult | { ok: boolean }>((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs[0]?.id

        if (!tabId) {
          reject(new Error('No active browser tab found.'))
          return
        }

        chrome.tabs.sendMessage(tabId, message, (response) => {
          const runtimeError = chrome.runtime.lastError?.message

          if (runtimeError) {
            reject(new Error(runtimeError))
            return
          }

          if (!response) {
            reject(new Error('Refresh the current page so the content script can attach.'))
            return
          }

          resolve(response)
        })
      })
    })
  }

  async function askReasoningServer(payload: AgentRequestPayload) {
    if (!extensionReady) {
      throw new Error('Server reasoning is available after loading this as an extension.')
    }

    return new Promise<ReasonResult>((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'NETRASHIELD_REASON', payload }, (response) => {
        const runtimeError = chrome.runtime.lastError?.message

        if (runtimeError) {
          reject(new Error(runtimeError))
          return
        }

        if (!response) {
          reject(new Error('No response from background reasoning worker.'))
          return
        }

        resolve(response)
      })
    })
  }

  async function runAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const cleanTask = task.trim()

    if (!cleanTask) {
      setError('Please enter a task for the agent.')
      setStatus('error')
      return
    }

    setStatus('scanning')
    setReasonStatus('idle')
    setError('')
    setReason(null)

    try {
      const scanResponse = (await sendToActiveTab({ type: 'NETRASHIELD_SCAN', mode })) as ScanResult
      setScan(scanResponse)
      setStatus('ready')

      await sendToActiveTab({ type: 'NETRASHIELD_APPLY_MASKS', mode })

      setReasonStatus('thinking')
      const response = await askReasoningServer({
        ...scanResponse.payload,
        task: cleanTask,
      })
      setReason(response)
      setReasonStatus('ready')

      if (response.command.type !== 'none') {
        await sendToActiveTab({ type: 'NETRASHIELD_EXECUTE_COMMAND', mode, command: response.command })
      }
    } catch (agentError) {
      setError(agentError instanceof Error ? agentError.message : 'Unable to run the agent.')
      setStatus('error')
      setReasonStatus('error')
    }
  }

  const isRunning = status === 'scanning' || reasonStatus === 'thinking'

  return (
    <main className="popup">
      <header className="popup-header">
        <div className="brand-mark">NS</div>
        <div>
          <p>NetraShield</p>
          <h1>Privacy Vision Agent</h1>
        </div>
      </header>

      <section className="mode-panel">
        <span className="section-label">Privacy mode</span>
        <div className="mode-grid" aria-label="Privacy mode">
          {privacyModes.map((privacyMode) => (
            <button
              className={mode === privacyMode.id ? 'selected' : ''}
              key={privacyMode.id}
              onClick={() => setMode(privacyMode.id)}
              type="button"
            >
              <strong>{privacyMode.title}</strong>
              <small>{privacyMode.caption}</small>
            </button>
          ))}
        </div>
      </section>

      <form className="task-panel" onSubmit={runAgent}>
        <label htmlFor="agent-task">
          <span className="section-label">What should I do?</span>
        </label>
        <textarea
          id="agent-task"
          maxLength={240}
          onChange={(event) => {
            setTask(event.target.value)
            setReason(null)
            setReasonStatus('idle')
            setError('')
          }}
          placeholder="Example: Help me submit this form."
          value={task}
        />
        <button className="primary-button submit-button" disabled={isRunning || !task.trim()} type="submit">
          {isRunning ? 'Working...' : 'Submit'}
        </button>
      </form>

      {status === 'error' || reasonStatus === 'error' ? <div className="error-box">{error}</div> : null}

      <section className="server-panel">
        <span className="section-label">Agent status</span>
        <h2>{getStatusTitle(status, reasonStatus, reason)}</h2>
        <p>
          {reason
            ? reason.command.instruction
            : scan
              ? 'Sensitive page content was masked locally before server reasoning.'
              : 'Enter a task and submit. The page will be inspected privately in the background.'}
        </p>
      </section>

      {!extensionReady && <footer className="dev-note">Dev preview: run build, then load the dist folder in Chrome extensions.</footer>}
    </main>
  )
}

const privacyModes: Array<{ id: PrivacyMode; title: string; caption: string }> = [
  { id: 'strict', title: 'Strict', caption: 'Maximum protection' },
  { id: 'balanced', title: 'Balanced', caption: 'Recommended' },
  { id: 'fast', title: 'Fast', caption: 'Low latency' },
]

function getStatusTitle(status: ScanStatus, reasonStatus: ReasonStatus, reason: ReasonResult | null) {
  if (status === 'scanning') {
    return 'Inspecting page privately'
  }

  if (reasonStatus === 'thinking') {
    return 'Getting safe action'
  }

  if (reason?.command.type === 'none') {
    return 'No action found'
  }

  if (reason) {
    return 'Action ready'
  }

  return 'Ready'
}

export default App
