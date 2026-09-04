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
      return 'Sensitive content is masked. Ask for the next step.'
    }

    return ''
  }, [error, reason, reasonStatus, scan, status])

  function updateTask(nextTask: string) {
    setTask(nextTask)
    setReason(null)
    setReasonStatus('idle')
    setError('')
  }

  function applySuggestion(suggestion: string) {
    updateTask(suggestion)
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

    try {
      await sendToActiveTab({ type: 'NETRASHIELD_DOM_ENQUIRY' })

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

  return {
    error,
    extensionReady,
    isRunning,
    messages,
    mode,
    reasonStatus,
    status,
    statusText,
    task,
    applySuggestion,
    runAgent,
    setMode,
    updateTask,
  }
}
