import type { AgentCommand, AgentRequestPayload, PrivacyMode, ReasonResult, ScanResult } from '../types/netrashield'

type ChromeTab = {
  id?: number
}

type TabMessage =
  | { type: 'NETRASHIELD_DOM_ENQUIRY'; task?: string }
  | { type: 'NETRASHIELD_SCAN' | 'NETRASHIELD_APPLY_MASKS' | 'NETRASHIELD_CLEAR_MASKS'; mode?: PrivacyMode }
  | { type: 'NETRASHIELD_EXECUTE_COMMAND'; mode?: PrivacyMode; command: AgentCommand }

type ChromeApi = {
  runtime: {
    lastError?: { message?: string }
    sendMessage: (
      message: { type: 'NETRASHIELD_REASON'; payload: AgentRequestPayload },
      callback: (response?: ReasonResult) => void,
    ) => void
  }
  tabs: {
    query: (queryInfo: { active: boolean; currentWindow: boolean }, callback: (tabs: ChromeTab[]) => void) => void
    sendMessage: (
      tabId: number,
      message: TabMessage,
      callback: (response?: ScanResult | { ok: boolean; count?: number; url?: string; title?: string }) => void,
    ) => void
  }
}

declare const chrome: ChromeApi | undefined

export function isExtensionReady() {
  return Boolean(getChrome())
}

export async function sendToActiveTab(message: TabMessage) {
  const chromeApi = getChrome()

  if (!chromeApi) {
    throw new Error('Build the app and load the dist folder as an unpacked Chrome extension.')
  }

  return new Promise<ScanResult | { ok: boolean; count?: number; url?: string; title?: string }>((resolve, reject) => {
    chromeApi.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id

      if (!tabId) {
        reject(new Error('No active browser tab found.'))
        return
      }

      chromeApi.tabs.sendMessage(tabId, message, (response) => {
        const runtimeError = chromeApi.runtime.lastError?.message

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

import { runOnnxInference } from '../lib/onnxInference'
import { loadSettings } from '../lib/settingsStorage'

export async function askReasoningServer(payload: AgentRequestPayload): Promise<ReasonResult> {
  const chromeApi = getChrome()

  if (chromeApi?.runtime?.sendMessage) {
    return new Promise<ReasonResult>((resolve) => {
      chromeApi.runtime.sendMessage({ type: 'NETRASHIELD_REASON', payload }, async (response) => {
        const runtimeError = chromeApi.runtime.lastError?.message

        if (runtimeError || !response) {
          console.warn('[NetraShield] Extension message error, attempting direct ONNX inference:', runtimeError)
          try {
            const onnxResult = await runOnnxInference(payload.task, payload)
            if (onnxResult) {
              resolve(onnxResult)
              return
            }
          } catch (onnxErr) {
            console.error('[NetraShield] Direct ONNX fallback failed:', onnxErr)
          }

          resolve({
            ok: false,
            source: 'extension-fallback',
            command: {
              type: 'none',
              targetId: '',
              instruction: 'Reasoning failed: Background worker unreachable.',
            },
            error: runtimeError || 'No response from background reasoning worker.',
          })
          return
        }

        resolve(response)
      })
    })
  }

  // Running outside extension environment (e.g. Vite dev preview or tests)
  const settings = await loadSettings()

  if (settings.reasoningEngine === 'server') {
    try {
      const res = await fetch(settings.serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        const data = await res.json()
        return {
          ok: true,
          source: 'server',
          command: data.command || {
            type: 'highlight',
            targetId: payload.elements[0]?.id || 'demo-target',
            instruction: `[Server] Processed sanitized request for task: "${payload.task}".`,
          },
          rationale: data.rationale || 'Processed by external reasoning server.',
        }
      }
    } catch (err) {
      console.warn('[NetraShield] Dev direct server call failed:', err)
    }
  }

  try {
    const onnxResult = await runOnnxInference(payload.task, payload)
    if (onnxResult) {
      return onnxResult
    }
  } catch (err) {
    console.warn('[NetraShield] Dev ONNX inference failed:', err)
  }

  return {
    ok: true,
    source: 'extension-fallback',
    command: {
      type: 'highlight',
      targetId: payload.elements[0]?.id || 'demo-target',
      instruction: `[Dev Fallback] Masked ${payload.redactions.length} regions. Ready for task: "${payload.task}".`,
    },
    rationale: 'Extension runtime not detected. Returned simulated safe guidance.',
  }
}

function getChrome() {
  return typeof chrome !== 'undefined' && chrome.tabs ? chrome : null
}
