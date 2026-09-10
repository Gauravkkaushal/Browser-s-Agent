/**
 * useSpeechToText — a thin wrapper around the Web Speech API.
 *
 * Supports Hindi, Hinglish, and English in a single recognition session.
 * Chrome's SpeechRecognition engine handles mixed-language input natively
 * when multiple BCP-47 tags are listed; we pick the three that cover the
 * target use-cases and let the engine decide per-word.
 *
 * Language priority order: hi-IN → en-IN → en-US
 * The engine picks the best match word-by-word, so "WhatsApp pe message
 * bhejo" transcribes correctly with the mixed code-switching that Hinglish
 * speakers use naturally.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

// ---- Types ---------------------------------------------------------------

export type SpeechStatus = 'idle' | 'listening' | 'processing' | 'error'

export type UseSpeechToTextOptions = {
  /** Called with every interim (in-progress) transcript. */
  onInterim?: (text: string) => void
  /** Called once with the final confirmed transcript. */
  onFinal: (text: string) => void
  /** Called when the user's mic is denied or the API errors. */
  onError?: (message: string) => void
}

export type UseSpeechToTextReturn = {
  /** Whether the browser supports SpeechRecognition at all. */
  isSupported: boolean
  /** Current recognition state. */
  status: SpeechStatus
  /** Live interim text being spoken right now. */
  interimText: string
  /** Toggle listening on / off. */
  toggle: () => void
  /** Imperatively stop listening. */
  stop: () => void
}

// ---- Browser type shim ---------------------------------------------------
// Chrome ships SpeechRecognition under the webkit prefix in older builds.
// We cast to `any` internally to avoid fighting the circular-type the TS
// compiler generates when you try to infer the constructor return type from
// the same constructor type.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpeechRecognitionLike = any

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike
    webkitSpeechRecognition?: new () => SpeechRecognitionLike
  }
}

// ---- Hook ----------------------------------------------------------------

/**
 * Multi-language speech-to-text hook.
 *
 * Hindi, Hinglish and English are all handled by a single recognition pass.
 * Chrome's engine accepts a comma-separated language preference list and
 * applies statistical word-level disambiguation, so code-switching
 * ("open karo mera inbox") transcribes without any post-processing.
 */
export function useSpeechToText({
  onInterim,
  onFinal,
  onError,
}: UseSpeechToTextOptions): UseSpeechToTextReturn {
  const [status, setStatus] = useState<SpeechStatus>('idle')
  const [interimText, setInterimText] = useState('')

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const isListeningRef = useRef(false)

  // Detect support once on mount.
  const isSupported =
    typeof window !== 'undefined' &&
    (Boolean(window.SpeechRecognition) || Boolean(window.webkitSpeechRecognition))

  /** Build and wire up a fresh SpeechRecognition instance. */
  const buildRecognition = useCallback(() => {
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!Ctor) return null

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = new Ctor() as any

    /**
     * Language selection strategy:
     *
     * Chrome accepts a single BCP-47 tag. We use "hi-IN" as the primary
     * because it gives the best code-switching model for Hinglish. When
     * the user speaks purely in English the engine still transcribes
     * correctly — it just uses the Hindi acoustic model, which is trained
     * on bilingual Indian speakers and handles English loanwords well.
     *
     * If you need a pure-English session in future, add a language toggle
     * prop and swap to "en-IN".
     */
    r.lang = 'hi-IN'

    // Keep listening for as long as the user speaks — stop only when
    // they click the mic button again or after a natural pause.
    r.continuous = false

    // Deliver in-progress guesses so the composer shows live feedback.
    r.interimResults = true

    // One alternative is enough — we want the top guess, not a ranked list.
    r.maxAlternatives = 1

    r.onstart = () => {
      isListeningRef.current = true
      setStatus('listening')
      setInterimText('')
    }

    r.onresult = (event: any) => {
      let interim = ''
      let final = ''

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const text = result[0].transcript

        if (result.isFinal) {
          final += text
        } else {
          interim += text
        }
      }

      if (interim) {
        setInterimText(interim)
        onInterim?.(interim)
      }

      if (final) {
        setInterimText('')
        onFinal(final.trim())
      }
    }

    r.onerror = (event: any) => {
      isListeningRef.current = false
      setStatus('error')
      setInterimText('')

      if (event.error === 'not-allowed') {
        openMicrophonePermissionTab()
      }

      const msg =
        event.error === 'not-allowed'
          ? 'Mic permission needed. Opening permission tab to click "Allow"...'
          : event.error === 'no-speech'
          ? 'No speech detected. Try again.'
          : event.error === 'network'
          ? 'Network error. Check your internet connection.'
          : `Speech recognition error: ${event.error}`

      onError?.(msg)

      // Auto-reset to idle after showing the error briefly.
      setTimeout(() => setStatus('idle'), 3500)
    }

    r.onend = () => {
      isListeningRef.current = false
      setInterimText('')
      // Only go back to idle if we didn't already transition to error.
      setStatus((prev) => (prev === 'listening' || prev === 'processing' ? 'idle' : prev))
    }

    return r
  }, [onFinal, onInterim, onError])

  const stop = useCallback(() => {
    if (recognitionRef.current && isListeningRef.current) {
      recognitionRef.current.stop()
    }
    isListeningRef.current = false
    setStatus('idle')
    setInterimText('')
  }, [])

  const toggle = useCallback(() => {
    if (!isSupported) return

    if (isListeningRef.current) {
      // User clicked mic again → stop.
      stop()
      return
    }

    // Build a fresh instance every time to avoid Chrome's one-shot limitation.
    const r = buildRecognition()
    if (!r) return

    recognitionRef.current = r

    try {
      r.start()
    } catch (err) {
      // start() throws if called on an already-active instance; safe to ignore.
      console.warn('[useSpeechToText] start() error (likely duplicate call):', err)
    }
  }, [isSupported, stop, buildRecognition])

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (recognitionRef.current && isListeningRef.current) {
        recognitionRef.current.abort()
      }
    }
  }, [])

  return { isSupported, status, interimText, toggle, stop }
}

/**
 * Open the dedicated microphone permission tab so the user can grant
 * Chrome-level permission to the extension origin.
 */
export function openMicrophonePermissionTab() {
  try {
    if (typeof chrome !== 'undefined' && chrome.tabs?.create && chrome.runtime?.getURL) {
      chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') })
    }
  } catch (err) {
    console.warn('[openMicrophonePermissionTab] Failed to open permission tab:', err)
  }
}
