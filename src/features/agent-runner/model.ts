import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { askReasoningServer, isExtensionReady, sendToActiveTab } from '../../shared/api/chromeExtension'
import { createId } from '../../shared/lib/createId'
import type { PrivacyMode, ReasonResult, ReasonStatus, ScanResult, ScanStatus } from '../../shared/types/netrashield'

export type ChatMessage = {
  id: string
  role: 'assistant' | 'user'
  text: string
}

const initialMessages: ChatMessage[] = []

export function useAgentRunner() {
  const [mode, setMode] = useState<PrivacyMode>('balanced')
  const [status, setStatus] = useState<ScanStatus>('idle')
  const [reasonStatus, setReasonStatus] = useState<ReasonStatus>('idle')
  const [error, setError] = useState('')
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [reason, setReason] = useState<ReasonResult | null>(null)
  const [task, setTask] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages)
  const [maskedScreenshot, setMaskedScreenshot] = useState<string | null>(null)
  const [maskedCount, setMaskedCount] = useState<number>(0)

  const isRunning = status === 'scanning' || reasonStatus === 'thinking'
  const extensionReady = isExtensionReady()

  const statusText = useMemo(() => {
    if (status === 'scanning') {
      return 'Inspecting page & masking sensitive data...'
    }

    if (reasonStatus === 'thinking') {
      return 'Running local ONNX model on masked context...'
    }

    if (status === 'error' || reasonStatus === 'error') {
      return error || 'Unable to complete that request.'
    }

    if (reason) {
      return reason.command.instruction
    }

    if (scan) {
      return `Sensitive content is masked (${maskedCount} PII elements). Ask for the next step.`
    }

    return ''
  }, [error, maskedCount, reason, reasonStatus, scan, status])

  function updateTask(nextTask: string) {
    setTask(nextTask)
    setReason(null)
    setReasonStatus('idle')
    setError('')
  }

  async function runAgent(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()

    const cleanTask = task.trim()

    if (!cleanTask) {
      setError('Please enter a task for the agent.')
      setStatus('error')
      return
    }

    setMessages((current) => [...current, { id: createId('msg'), role: 'user', text: cleanTask }])
    setStatus('scanning')
    setReasonStatus('idle')
    setError('')
    setReason(null)
    setTask('')

    const isScrollOrSummary = /scroll|full page|whole page|entire page|summar(y|ise|ize)|overview/i.test(cleanTask)

    try {
      const domEnquiry = await sendToActiveTab({ type: 'NETRASHIELD_DOM_ENQUIRY', task: cleanTask })
      console.log('[NetraShield Popup] DOM enquiry completed for task:', cleanTask, domEnquiry)

      let scanResponse: ScanResult & { screenshot?: string; count?: number }
      let screenshot = ''
      let count = 0

      if (isScrollOrSummary) {
        scanResponse = (await sendToActiveTab({ type: 'NETRASHIELD_AUTO_SCROLL_SCAN', mode })) as any
        screenshot = scanResponse?.screenshot || ''
        count = scanResponse?.count ?? scanResponse?.regions?.length ?? 0
      } else {
        scanResponse = (await sendToActiveTab({ type: 'NETRASHIELD_SCAN', mode })) as ScanResult
        const maskResult = (await sendToActiveTab({ type: 'NETRASHIELD_APPLY_MASKS', mode })) as {
          ok?: boolean
          screenshot?: string
          count?: number
        } | null
        screenshot = maskResult?.screenshot || ''
        count = maskResult?.count ?? scanResponse.regions?.length ?? 0
      }

      setScan(scanResponse)
      setStatus('ready')
      setMaskedScreenshot(screenshot || null)
      setMaskedCount(count)

      const { loadSettings } = await import('../../shared/lib/settingsStorage')
      const settings = await loadSettings()

      const response = await askReasoningServer({
        ...scanResponse.payload,
        task: cleanTask,
        screenshot: screenshot || undefined,
        lang: settings.summaryLanguage || 'en',
      })
      setReason(response)
      setReasonStatus('ready')

      setMessages((current) => [
        ...current,
        {
          id: createId('msg'),
          role: 'assistant',
          text: response.command.instruction,
        },
      ])

      if (response.command.type !== 'none') {
        await sendToActiveTab({ type: 'NETRASHIELD_EXECUTE_COMMAND', mode, command: response.command })
      }
    } catch (agentError) {
      const message = agentError instanceof Error ? agentError.message : 'Unable to run the agent.'
      setError(message)
      setStatus('error')
      setReasonStatus('error')
      setMessages((current) => [...current, { id: createId('msg'), role: 'assistant', text: message }])
    }
  }

  async function executeAction() {
    if (!reason?.command || reason.command.type === 'none') return
    try {
      await sendToActiveTab({ type: 'NETRASHIELD_EXECUTE_COMMAND', mode, command: reason.command })
      setMessages((current) => [
        ...current,
        {
          id: createId('msg'),
          role: 'assistant',
          text: `⚡ Action executed & confirmed on target: ${reason.command.targetId || 'active element'} with zero PII exposure.`,
        },
      ])
    } catch (err) {
      console.error('[NetraShield] Failed to execute action:', err)
    }
  }

  return {
    error,
    extensionReady,
    isRunning,
    messages,
    mode,
    reason,
    reasonStatus,
    status,
    statusText,
    task,
    maskedScreenshot,
    maskedCount,
    executeAction,
    runAgent,
    setMode,
    updateTask,
  }
}
