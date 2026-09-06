import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { isExtensionReady } from '../../shared/api/chromeExtension'
import { createId } from '../../shared/lib/createId'
import type { PrivacyMode } from '../../shared/types/netrashield'

/**
 * Drives the closed-loop agent from inside the popup.
 *
 * The engine runs in the reasoning server and broadcasts every real event over
 * a WebSocket. This hook is the only thing that listens: it turns those events
 * into the chat thread, the status line and the masked-snapshot proof that the
 * popup already knows how to render. Nothing here invents progress — if a line
 * appears in the thread, an event produced it.
 *
 * A browser-action popup is torn down the moment it loses focus, so on every
 * mount we reconnect and the server replays what has happened. The task itself
 * never pauses; it lives in the server, not in this window.
 */

export type ChatMessage = {
  id: string
  role: 'assistant' | 'user'
  text: string
}

/**
 * What was hidden before the model was allowed to read anything.
 *
 * Every field here is measured, not asserted: the counts come from the
 * redactor's own tally as it ran inside the page, and `llmInputSample` is a
 * verbatim slice of the bytes the model actually received. A privacy claim
 * nobody can inspect is a privacy claim nobody should believe.
 */
export type MaskingReport = {
  byType: Record<string, number>
  piiTotal: number
  /** How many PLACES those values were hidden in. */
  occurrences: number
  /** What each blacked-out box covers: kind and position, never the value. */
  regions: { kind: string; box: number[] }[]
  maskedRegions: number
  injectionsNeutralized: number
  injections: { kind: string; text: string }[]
  llmInputSample: string
  /** Set when the page could only be read from a screenshot. */
  readBySight?: boolean
  /** Why that capture could or could not be masked. */
  maskNote?: string
}

export type PendingConfirmation = {
  actionId: string
  preview: string
  textPreview: string
  targetName: string
  url: string
  reason: string
  rulesFired: string[]
  screenshot: string | null
  requiresLiveHuman: boolean
}

type Envelope = {
  v: number
  type: string
  ts: string
  task_id: string | null
  step: number
  seq: number
  payload: Record<string, any>
}

function isDetachedNow(): boolean {
  return typeof location !== 'undefined' && location.hash.startsWith('#detached')
}

const SERVER_HTTP = 'http://127.0.0.1:8787'
const SERVER_WS = 'ws://127.0.0.1:8787/ws/cockpit'
const RECONNECT_MS = 1500

/** Events worth showing a human. The rest is plumbing. */
const NARRATED = new Set([
  'PLAN_GENERATED', 'ACTION_PROPOSED', 'POLICY_DENIED', 'CONFIRMATION_REQUESTED',
  'CONFIRMATION_GRANTED', 'CONFIRMATION_DENIED', 'ACTION_VERIFIED',
  'VERIFICATION_FAILED', 'RECOVERY_COMPLETED', 'LOGIN_REQUIRED', 'LOGIN_DETECTED',
  'TASK_COMPLETED', 'TASK_FAILED', 'TASK_CANCELLED', 'ERROR',
])

function describe(e: Envelope): string | null {
  const p = e.payload || {}
  switch (e.type) {
    case 'PLAN_GENERATED': {
      const steps = (p.steps || []).map((s: any, i: number) => `${i + 1}. ${s.goal}`).join('\n')
      return `${p.replanned ? 'Rewrote the plan now that I know the task' : 'Plan'}: ${p.objective}\n${steps}`
    }
    case 'ACTION_PROPOSED':
      return `${p.preview || p.action} — ${p.reason || ''}`.trim()
    case 'POLICY_DENIED':
      return `Refused: ${p.decision?.reason || 'blocked by policy'}`
    case 'CONFIRMATION_REQUESTED':
      return `Waiting for your approval: ${p.preview}`
    case 'CONFIRMATION_GRANTED':
      return `Approved — ${p.preview}`
    case 'CONFIRMATION_DENIED':
      return `You declined. ${p.reason || ''}`.trim()
    case 'ACTION_VERIFIED':
      return `Done: ${p.action}`
    case 'VERIFICATION_FAILED':
      return p.counted_as_strike === false ? null : `That did not take effect — trying another way.`
    case 'RECOVERY_COMPLETED':
      return p.handled ? `Recovered: ${p.detail}` : null
    case 'LOGIN_REQUIRED':
      return `Sign-in needed on ${p.app}. ${p.hint} I will carry on by myself once you are in.`
    case 'LOGIN_DETECTED':
      return `Signed in. Continuing where I left off.`
    case 'TASK_COMPLETED':
      return p.summary || 'Done.'
    case 'TASK_FAILED':
      return `Stopped: ${p.error}`
    case 'TASK_CANCELLED':
      return `Cancelled. ${p.reason || ''}`.trim()
    case 'ERROR':
      return p.error
    default:
      return null
  }
}

/**
 * The standing authorisation, remembered.
 *
 * Chrome destroys the popup constantly, so a choice held only in component
 * state is a choice you have to make again every single time you open it --
 * which is exactly the "why is it asking me again?" that made this setting
 * useless. It belongs in storage, not in a React hook.
 */
const PRE_APPROVE_KEY = 'agent.preApprove'

function loadPreApprove(apply: (value: boolean) => void) {
  try {
    chrome.storage?.local?.get(PRE_APPROVE_KEY, (bag) => {
      if (chrome.runtime?.lastError) return
      apply(Boolean(bag?.[PRE_APPROVE_KEY]))
    })
  } catch {
    /* not running as an extension; the default stands */
  }
}

function savePreApprove(value: boolean) {
  try {
    chrome.storage?.local?.set({ [PRE_APPROVE_KEY]: value })
  } catch {
    /* nothing to persist to */
  }
}

export function useAgentRunner() {
  const [mode, setMode] = useState<PrivacyMode>('balanced')
  const [task, setTask] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [maskedScreenshot, setMaskedScreenshot] = useState<string | null>(null)
  const [maskedCount, setMaskedCount] = useState(0)
  const [masking, setMasking] = useState<MaskingReport | null>(null)
  const [blocked, setBlocked] = useState<string[]>([])
  const [statusText, setStatusText] = useState('')
  const [error, setError] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [connected, setConnected] = useState(false)
  const [browserLinked, setBrowserLinked] = useState(false)
  const [pending, setPending] = useState<PendingConfirmation | null>(null)
  const [preApprove, setPreApproveState] = useState(false)
  // Which page the agent would act on. Empty means there is none.
  const [targetPage, setTargetPage] = useState<string | null>(null)

  /**
   * Ask the worker what page it can see, and keep asking.
   *
   * "There is no web page open" is something you need while you are writing the
   * command, not after a plan has been made and thrown away -- which is exactly
   * what "explain this page" did when the only windows open were the agent's
   * own and chrome://extensions, neither of which an extension can read.
   */
  useEffect(() => {
    let alive = true
    const poll = () => {
      try {
        chrome.runtime?.sendMessage({ type: 'AGENT_STATUS' }, (reply: any) => {
          if (!alive || chrome.runtime?.lastError || !reply) return
          setTargetPage(reply.target_url || '')
        })
      } catch {
        /* not running as an extension */
      }
    }
    poll()
    const timer = setInterval(poll, 4000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  // Restore the operator's standing answer before anything can ask them again.
  useEffect(() => {
    loadPreApprove(setPreApproveState)
  }, [])

  const setPreApprove = useCallback((value: boolean) => {
    setPreApproveState(value)
    savePreApprove(value)
  }, [])

  const socketRef = useRef<WebSocket | null>(null)
  // runAgent is declared before detach, so reach it through a ref.
  const detachRef = useRef<(() => void) | null>(null)
  const taskIdRef = useRef<string | null>(null)
  const seenRef = useRef<Set<number>>(new Set())
  const extensionReady = isExtensionReady()

  const push = useCallback((role: ChatMessage['role'], text: string) => {
    setMessages((current) => {
      const last = current[current.length - 1]
      if (last && last.role === role && last.text === text) return current
      return [...current, { id: createId('msg'), role, text }]
    })
  }, [])

  const handle = useCallback((e: Envelope) => {
    // The server replays history on reconnect; do not narrate it twice.
    if (e.seq) {
      if (seenRef.current.has(e.seq)) return
      seenRef.current.add(e.seq)
    }
    const p = e.payload || {}
    if (e.task_id) taskIdRef.current = e.task_id

    switch (e.type) {
      case 'STATE_CHANGED': {
        const done = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(p.state)
        setIsRunning(!done)
        setStatusText(p.detail ? `${p.state} — ${p.detail}` : String(p.state).toLowerCase())
        break
      }
      case 'OBSERVATION_RECEIVED': {
        setStatusText(`Looking at ${String(p.url || '').slice(0, 60)}`)
        // The masked snapshot is proof of what was blacked out before anything
        // left the machine. Only replace it when a new one actually arrives.
        if (p.screenshot) setMaskedScreenshot(`data:image/jpeg;base64,${p.screenshot}`)
        break
      }
      case 'MASKING_APPLIED': {
        const byType = (p.pii_redactions || {}) as Record<string, number>
        const occ = Object.values(p.pii_occurrences || {})
          .reduce((a: number, b: any) => a + Number(b || 0), 0)
        setMasking({
          byType,
          occurrences: occ,
          regions: p.regions || [],
          piiTotal: Number(p.pii_total || 0),
          maskedRegions: Number(p.masked_regions || 0),
          injectionsNeutralized: Number(p.injections_neutralized || 0),
          injections: p.injections || [],
          llmInputSample: String(p.llm_input_sample || ''),
        })
        // The badge counts everything withheld: values replaced in the text and
        // regions blacked out of the screenshot.
        setMaskedCount(Number(p.pii_total || 0) + Number(p.masked_regions || 0))
        break
      }
      case 'PAGE_READ_BY_SIGHT':
        // A page the browser forbids content scripts on. Masking needs that
        // script, so say plainly whether the capture was redacted -- claiming
        // privacy that did not happen is worse than admitting the gap.
        setMasking((current) => ({
          byType: { ...(current?.byType || {}), ...(p.redacted_after_reading || {}) },
          piiTotal: Object.values(p.redacted_after_reading || {})
            .reduce((a: number, b: any) => a + Number(b || 0), 0),
          maskedRegions: current?.maskedRegions || 0,
          occurrences: current?.occurrences || 0,
          regions: current?.regions || [],
          injectionsNeutralized: current?.injectionsNeutralized || 0,
          injections: current?.injections || [],
          llmInputSample: current?.llmInputSample || '',
          readBySight: true,
          maskNote: String(p.mask_note || ''),
        }))
        break
      case 'SECURITY_BLOCKED':
        setBlocked((current) => [...current.slice(-4), String(p.reason || '')])
        break
      case 'CONFIRMATION_REQUESTED':
        setPending({
          actionId: p.action_id,
          preview: p.preview || '',
          textPreview: p.text_preview || '',
          targetName: p.target_name || '',
          url: p.url || '',
          reason: p.reason || '',
          rulesFired: p.decision?.rules_fired || [],
          screenshot: p.screenshot ? `data:image/jpeg;base64,${p.screenshot}` : null,
          requiresLiveHuman: !!p.requires_live_human,
        })
        break
      case 'CONFIRMATION_GRANTED':
      case 'CONFIRMATION_DENIED':
        setPending(null)
        break
      case 'TASK_COMPLETED':
      case 'TASK_FAILED':
      case 'TASK_CANCELLED':
        setIsRunning(false)
        setPending(null)
        if (e.type === 'TASK_FAILED') setError(p.error || '')
        break
      case 'WS_CONNECTED':
        setBrowserLinked(true)
        break
      case 'WS_DISCONNECTED':
        setBrowserLinked(false)
        break
      case 'ERROR':
        setError(p.error || '')
        break
    }

    if (NARRATED.has(e.type)) {
      const line = describe(e)
      if (line) push('assistant', line)
    }
  }, [push])

  // -- transport ------------------------------------------------------------
  useEffect(() => {
    let closed = false
    let retry: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (closed) return
      let ws: WebSocket
      try {
        ws = new WebSocket(SERVER_WS)
      } catch {
        retry = setTimeout(connect, RECONNECT_MS)
        return
      }
      socketRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        setError('')
      }
      ws.onclose = () => {
        setConnected(false)
        socketRef.current = null
        if (!closed) retry = setTimeout(connect, RECONNECT_MS)
      }
      ws.onmessage = (event) => {
        let msg: any
        try {
          msg = JSON.parse(event.data)
        } catch {
          return
        }
        if (msg.type === 'HELLO') {
          setBrowserLinked(!!msg.payload?.browser_connected)
          // A browser-action popup is destroyed the moment it loses focus, and
          // the agent takes focus every time it opens a tab. So on every mount
          // we rebuild from the server: the snapshot restores the last masked
          // shot and any pending approval, and the replay refills the thread.
          const snap = msg.payload?.snapshot
          if (snap) {
            if (snap.last_screenshot) {
              setMaskedScreenshot(`data:image/jpeg;base64,${snap.last_screenshot}`)
            }
            const live = !['COMPLETED', 'FAILED', 'CANCELLED'].includes(snap.state)
            setIsRunning(live)
            if (snap.task_id) taskIdRef.current = snap.task_id
            if (snap.command) push('user', snap.command)
            if (snap.state) setStatusText(String(snap.state).toLowerCase())
          }
          // Replay only THIS task. The event bus keeps one ring buffer for the
          // whole server, so an unfiltered replay refills the thread with the
          // previous task's narration -- and since the snapshot's command is
          // pushed first, the message you just sent ends up buried above the
          // old task's output instead of sitting at the end where you wrote it.
          const current = snap?.task_id
          ;(msg.payload?.replay || [])
            .filter((ev: Envelope) => !current || ev.task_id === current)
            .forEach((ev: Envelope) => handle(ev))
          return
        }
        if (msg.type === 'PONG') return
        handle(msg)
      }
    }

    connect()
    const ping = setInterval(() => {
      const ws = socketRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ v: 1, type: 'PING', payload: {} }))
      }
    }, 25000)

    return () => {
      closed = true
      clearInterval(ping)
      if (retry) clearTimeout(retry)
      socketRef.current?.close()
    }
  }, [handle])

  const send = useCallback((type: string, payload: Record<string, unknown>) => {
    const ws = socketRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError('Not connected to the reasoning server. Start it with: npm run server')
      return false
    }
    ws.send(JSON.stringify({ v: 1, type, ts: new Date().toISOString(), payload }))
    return true
  }, [])

  const statusLine = useMemo(() => {
    if (!connected) return 'Connecting to the reasoning server…'
    if (!browserLinked) return 'Waiting for the extension to attach — open any normal web page.'
    if (pending) return 'Waiting for your approval.'
    return statusText
  }, [connected, browserLinked, pending, statusText])

  // A page it can read, the host it would act on, or nothing at all.
  const pageLine = useMemo(() => {
    if (targetPage === null) return ''
    if (!targetPage) return 'No web page open — open a normal http(s) tab first.'
    try {
      return 'Working on ' + new URL(targetPage).hostname
    } catch {
      return 'Working on ' + targetPage.slice(0, 40)
    }
  }, [targetPage])

  function updateTask(next: string) {
    setTask(next)
  }

  function runAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const command = task.trim()
    if (!command || isRunning) return

    setError('')
    setMessages([])
    seenRef.current = new Set()
    setMaskedScreenshot(null)
    setMaskedCount(0)
    setMasking(null)
    setBlocked([])
    push('user', command)

    if (send('TASK_CREATE', { command, pre_approved: preApprove, privacy_mode: mode })) {
      setIsRunning(true)
      setStatusText('Planning…')
      setTask('')
      // A task started from the popup is a task you cannot watch: the agent
      // opens a tab, focus moves, Chrome destroys the popup. The task itself
      // lives in the server, so stepping into a window costs nothing -- it
      // reconnects, the server replays what has happened, and it stays put.
      if (!isDetachedNow()) detachRef.current?.()
    }
  }

  const approve = useCallback(() => {
    send('CONFIRMATION_GRANTED', { task_id: taskIdRef.current, scope: 'once' })
    setPending(null)
  }, [send])

  /**
   * Answer for the rest of this task, not just for this one action.
   *
   * Being asked separately about every message in a run is what stops a task
   * finishing: the window loses focus, nobody answers, and the send is dropped.
   * The policy layer still classifies and logs every action, and an
   * authentication code still stops for a person regardless of this.
   */
  const approveAll = useCallback(() => {
    setPreApprove(true)
    send('CONFIRMATION_GRANTED', { task_id: taskIdRef.current, scope: 'task' })
    setPending(null)
  }, [send, setPreApprove])

  const deny = useCallback(() => {
    send('CONFIRMATION_DENIED', { task_id: taskIdRef.current })
    setPending(null)
  }, [send])

  const cancel = useCallback(() => {
    send('TASK_CANCEL', { task_id: taskIdRef.current })
  }, [send])

  /**
   * Reopen this same UI as a standalone window.
   *
   * Chrome destroys a browser-action popup as soon as it loses focus, and the
   * agent takes focus every time it opens a tab -- so watching a task from the
   * popup means watching it vanish. A detached window survives, and you can
   * put it beside the tab the agent is driving.
   */
  /**
   * Reopen this UI as a standalone window, where the popup already is.
   *
   * Chrome anchors the popup under the extension icon and destroys it the
   * moment focus moves -- and the agent takes focus every time it opens a tab.
   * The window replaces it in the same spot so nothing appears to jump.
   */
  const detach = useCallback(() => {
    try {
      // Close this popup only once the new window actually exists. Closing
      // first races the creation and can leave you with neither.
      chrome.windows.create(
        {
          url: chrome.runtime.getURL('index.html') + '#detached',
          type: 'popup',
          // The popup body is 390x600. chrome.windows.create sizes the OUTER
          // window, frame included, so ask for a little more or the content is
          // clipped. In detached mode the layout also stretches to fill,
          // so resizing the window works properly from here on.
          width: 406,
          height: 648,
          // Put it exactly where the popup is standing, so it reads as the
          // same panel staying put rather than a new window appearing
          // somewhere else on the screen.
          left: Math.max(0, Math.round(window.screenX)),
          top: Math.max(0, Math.round(window.screenY)),
        },
        (created?: unknown) => {
          if (created) window.close()
          else setError('Could not open a separate window.')
        },
      )
    } catch {
      setError('Could not open a separate window.')
    }
  }, [])

  const isDetached = isDetachedNow()
  detachRef.current = detach

  return {
    error,
    extensionReady: extensionReady && browserLinked,
    isRunning,
    messages,
    mode,
    statusText: statusLine,
    pageLine,
    hasPage: targetPage === null || Boolean(targetPage),
    task,
    maskedScreenshot,
    maskedCount,
    masking,
    blocked,
    connected,
    browserLinked,
    pending,
    preApprove,
    setPreApprove,
    approve,
    approveAll,
    deny,
    cancel,
    runAgent,
    setMode,
    updateTask,
    detach,
    isDetached,
    serverUrl: SERVER_HTTP,
  }
}
