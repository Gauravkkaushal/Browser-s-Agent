import type { AgentCommand, AgentRequestPayload, PrivacyMode, ReasonResult, ScanResult } from '../types/netrashield'

type ChromeTab = {
  id?: number
}

type TabMessage =
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
    sendMessage: (tabId: number, message: TabMessage, callback: (response?: ScanResult | { ok: boolean }) => void) => void
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

  return new Promise<ScanResult | { ok: boolean }>((resolve, reject) => {
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

export async function askReasoningServer(payload: AgentRequestPayload) {
  const chromeApi = getChrome()

  if (!chromeApi) {
    throw new Error('Server reasoning is available after loading this as an extension.')
  }

  return new Promise<ReasonResult>((resolve, reject) => {
    chromeApi.runtime.sendMessage({ type: 'NETRASHIELD_REASON', payload }, (response) => {
      const runtimeError = chromeApi.runtime.lastError?.message

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

function getChrome() {
  return typeof chrome !== 'undefined' && chrome.tabs ? chrome : null
}
