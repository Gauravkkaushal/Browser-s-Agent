import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { ArrowUpOutlined, AudioMutedOutlined, AudioOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons'
import { Button, Input, Select, Tooltip, Typography } from 'antd'
import type { ChatHistoryThread, ChatMessage, MaskingReport, PendingConfirmation } from '../../features/agent-runner/model'
import { privacyModes } from '../../entities/mode/model'
import type { PrivacyMode } from '../../shared/types/netrashield'
import { openMicrophonePermissionTab, useSpeechToText } from '../../shared/lib/useSpeechToText'
import { SettingsDrawer } from '../settings/SettingsDrawer'
import './ChatShell.css'

type ChatShellProps = {
  extensionReady: boolean
  isRunning: boolean
  messages: ChatMessage[]
  mode: PrivacyMode
  statusText: string
  task: string
  maskedScreenshot?: string | null
  maskedCount?: number
  pageLine?: string
  hasPage?: boolean
  masking?: MaskingReport | null
  blocked?: string[]
  history?: ChatHistoryThread[]
  pending?: PendingConfirmation | null
  preApprove?: boolean
  onPreApproveChange?: (value: boolean) => void
  onApprove?: () => void
  onApproveAll?: () => void
  onDeny?: () => void
  onCancel?: () => void
  onNewChat?: () => void
  onDetach?: () => void
  isDetached?: boolean
  onModeChange: (mode: PrivacyMode) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onTaskChange: (task: string) => void
  localModelStatus?: string | null
}

export function ChatShell({
  extensionReady,
  isRunning,
  messages,
  mode,
  statusText,
  task,
  maskedScreenshot,
  maskedCount = 0,
  pageLine = '',
  hasPage = true,
  masking,
  blocked = [],
  history = [],
  pending,
  preApprove = false,
  onPreApproveChange,
  onApprove,
  onApproveAll,
  onDeny,
  onCancel,
  onNewChat,
  onDetach,
  isDetached = false,
  onModeChange,
  onSubmit,
  onTaskChange,
  localModelStatus,
}: ChatShellProps) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [shieldOpen, setShieldOpen] = useState(false)
  const [activePanel, setActivePanel] = useState<'chat' | 'details' | 'history'>('chat')
  const [voiceError, setVoiceError] = useState<string | null>(null)

  // ---- Speech-to-Text ---------------------------------------------------
  // The hook handles Hindi, Hinglish, and English in a single pass.
  // Interim results appear in the composer live; on final the transcript
  // is appended to whatever the user had already typed.
  const stt = useSpeechToText({
    onInterim: (_text) => {
      // Interim is shown via stt.interimText — no state change needed here.
    },
    onFinal: (text) => {
      // Append final transcript to existing task (with a space separator).
      onTaskChange(
        (task.trim() ? task.trim() + ' ' : '') + text
      )
    },
    onError: (msg) => {
      setVoiceError(msg)
      setTimeout(() => setVoiceError(null), 6000)
    },
  })

  /**
   * Keep the newest line in view, the way every chat does.
   *
   * The thread scrolls, but nothing was ever scrolling it, so each new line
   * landed below the fold: you sent something and the view stayed where it
   * was, showing older text, as though your message had gone nowhere.
   *
   * Following is conditional on already being at the bottom. If you have
   * scrolled up to read something, arriving text must not yank you away --
   * a chat that fights you when you scroll back is worse than one that
   * does not follow at all.
   */
  const threadRef = useRef<HTMLElement | null>(null)
  const stickToBottom = useRef(true)

  const onThreadScroll = () => {
    const node = threadRef.current
    if (!node) return
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight
    stickToBottom.current = distanceFromBottom < 60
  }

  useEffect(() => {
    const node = threadRef.current
    if (!node || !stickToBottom.current) return
    node.scrollTop = node.scrollHeight
  }, [messages, statusText, pending, isRunning])

  // Whatever you type is the newest thing in the thread by definition, so
  // sending always returns you to the bottom even if you had scrolled up.
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    stickToBottom.current = true
    onSubmit(event)
  }

  const modeOptions = privacyModes.map((privacyMode) => ({
    label: privacyMode.title,
    value: privacyMode.id,
  }))
  const hasDetails = Boolean(masking || blocked.length > 0 || maskedScreenshot)
  const historyCount = history.length

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) {
      return
    }

    event.preventDefault()

    if (isRunning || !task.trim()) {
      return
    }

    event.currentTarget.form?.requestSubmit()
  }

  return (
    <main className="chat-popup" aria-label="NetraShield assistant">
      <section className="assistant-header" aria-label="Assistant status">
        <div className="brand-lockup">
          <div className="brand-orb" aria-hidden="true">
            N
          </div>
          <div>
            <Typography.Text className="brand-title">
              NetraShield
              <span
                className={`brand-status-dot${isRunning ? ' busy' : extensionReady ? ' ready' : ''}`}
                aria-hidden="true"
              />
            </Typography.Text>
            <Typography.Text className="brand-subtitle">
              {isRunning ? statusText || 'Working…' : 'Private page assistant'}
            </Typography.Text>
            {localModelStatus && (
              <span className="nano-pill">Nano: {localModelStatus}</span>
            )}
          </div>
        </div>
        {!isDetached && (
          <Button
            className="detach-button"
            size="small"
            type="text"
            onClick={onDetach}
            title="Chrome closes this popup whenever the agent opens a tab. Open it as its own window and it stays put."
          >
            Keep open
          </Button>
        )}
      </section>

      <SettingsDrawer
        onClose={() => setSettingsOpen(false)}
        open={settingsOpen}
      />

      <nav className="panel-tabs" aria-label="NetraShield views">
        <button
          type="button"
          className={activePanel === 'chat' ? 'active' : ''}
          onClick={() => setActivePanel('chat')}
        >
          Chat
        </button>
        <button
          type="button"
          className={activePanel === 'details' ? 'active' : ''}
          onClick={() => setActivePanel('details')}
        >
          More details
          {hasDetails && <span className="details-dot" aria-hidden="true" />}
        </button>
        <button
          type="button"
          className={activePanel === 'history' ? 'active' : ''}
          onClick={() => setActivePanel('history')}
        >
          History
          {historyCount > 0 && <span className="tab-count">{historyCount}</span>}
        </button>
        <button
          type="button"
          className="new-chat-tab"
          disabled={isRunning}
          onClick={() => {
            onNewChat?.()
            setActivePanel('chat')
          }}
        >
          New chat
        </button>
      </nav>

      {activePanel === 'chat' && messages.length === 0 && !isRunning && (
        <section className="hero-copy" aria-label="Greeting">
          <Typography.Title level={1}>
            <span>Hello, Gaurav.</span>
            What should we handle on this page?
          </Typography.Title>
          <Typography.Paragraph>
            Ask naturally. Sensitive fields are masked locally before any reasoning starts.
          </Typography.Paragraph>

          {/*
            Quick actions, from Gaurav's upstream work.
            There they called dedicated NETRASHIELD_* extension messages. Here
            they fill the composer instead: this agent takes plain English and
            plans the scrolling and reading itself, so a shortcut only needs to
            say what you want -- and you can edit it before sending, which the
            fixed buttons could not.
          */}
          <div className="quick-actions-list">
            <button
              type="button"
              className="quick-action-pill"
              onClick={() => onTaskChange('Scroll through the whole page and give a complete summary')}
            >
              <span className="qa-icon" aria-hidden="true">📜</span>
              <span className="qa-text">Full Page Scroll &amp; Summarize</span>
            </button>
            <button
              type="button"
              className="quick-action-pill"
              onClick={() => onTaskChange('Scan and redact all sensitive PII on this page')}
            >
              <span className="qa-icon" aria-hidden="true">🛡️</span>
              <span className="qa-text">Scan &amp; Redact Sensitive PII</span>
            </button>
          </div>
        </section>
      )}

      {activePanel === 'chat' && (messages.length > 0 || isRunning) && (
        <section
          className="chat-thread"
          aria-label="Conversation"
          ref={threadRef}
          onScroll={onThreadScroll}
        >
          {messages.map((message) => (
            <div className={`message-row ${message.role}`} key={message.id}>
              {message.role === 'assistant' && (
                <span className="message-avatar" aria-hidden="true">N</span>
              )}
              <article className={`message ${message.role}`}>{message.text}</article>
            </div>
          ))}
          {isRunning && (
            <div className="message-row assistant">
              <span className="message-avatar" aria-hidden="true">N</span>
              <article className="message assistant pending">{statusText}</article>
            </div>
          )}
          {pending && (
            <div className="approval-card" role="alertdialog" aria-label="Approval required">
              <div className="approval-head">
                <span className="approval-dot" />
                <span>Approval needed</span>
                {pending.requiresLiveHuman && (
                  <span className="approval-live">cannot be pre-approved</span>
                )}
              </div>
              <div className="approval-action">{pending.preview}</div>
              {pending.textPreview && (
                <div className="approval-text">{pending.textPreview}</div>
              )}
              <dl className="approval-meta">
                <dt>page</dt><dd>{pending.url}</dd>
                {pending.reason ? (<><dt>why</dt><dd>{pending.reason}</dd></>) : null}
                <dt>rules</dt><dd>{pending.rulesFired.join(', ') || '—'}</dd>
              </dl>
              {pending.screenshot && (
                <img
                  src={pending.screenshot}
                  alt="Page at the moment of the request, sensitive regions blacked out"
                  className="approval-img"
                />
              )}
              <div className="approval-actions">
                <Button size="small" onClick={onDeny}>Cancel</Button>
                {!pending.requiresLiveHuman && (
                  <Button size="small" onClick={onApproveAll}>Don't ask again</Button>
                )}
                <Button size="small" type="primary" onClick={onApprove}>Approve</Button>
              </div>
            </div>
          )}
        </section>
      )}

      {activePanel === 'details' && (
        <section className="details-panel" aria-label="More details">
          {!hasDetails && (
            <div className="details-empty">
              Redaction details will appear here after NetraShield reads a page.
            </div>
          )}

          {(masking || blocked.length > 0) && (
            <section className="shield-panel" aria-label="What was hidden from the model">
              <button
                type="button"
                className="shield-head"
                onClick={() => setShieldOpen((open) => !open)}
                aria-expanded={shieldOpen}
              >
                <span className="shield-dot" />
                <span className="shield-title">
                  {masking ? `${masking.piiTotal + masking.maskedRegions} hidden before the model read anything` : 'Blocked'}
                </span>
                <span className="shield-caret">{shieldOpen ? '−' : '+'}</span>
              </button>

              {masking && (
                <div className="shield-chips">
                  {Object.entries(masking.byType).map(([kind, n]) => (
                    <span className="shield-chip" key={kind}>{kind} ×{n}</span>
                  ))}
                  {masking.occurrences > masking.piiTotal && (
                    <span className="shield-chip quiet">
                      in {masking.occurrences} places
                    </span>
                  )}
                  {masking.maskedRegions > 0 && (
                    <span className="shield-chip regions">blacked out ×{masking.maskedRegions}</span>
                  )}
                  {masking.injectionsNeutralized > 0 && (
                    <span className="shield-chip danger">
                      page tried to give orders ×{masking.injectionsNeutralized}
                    </span>
                  )}
                  {masking.readBySight && (
                    <span className="shield-chip danger">read from a screenshot</span>
                  )}
                  {masking.piiTotal === 0 && masking.maskedRegions === 0 && !masking.readBySight && (
                    <span className="shield-chip quiet">nothing sensitive on this page</span>
                  )}
                </div>
              )}

              {masking?.maskNote && (
                <p className="shield-warn">{masking.maskNote}</p>
              )}

              {shieldOpen && masking && (
                <>
                  <p className="shield-note">
                    This is the text the model actually received. Every
                    <code>[REDACTED:…]</code> is a value it never saw.
                  </p>
                  <pre className="shield-sample">{masking.llmInputSample || '(no page text)'}</pre>
                  {masking.regions.length > 0 && (
                    <>
                      <p className="shield-note">
                        Each black box on the snapshot, and what it covers.
                      </p>
                      <ul className="shield-injections">
                        {masking.regions.map((r, i) => (
                          <li key={i}>
                            <b>{r.kind}</b> — {r.box[2]}×{r.box[3]} at {r.box[0]},{r.box[1]}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {masking.injections.length > 0 && (
                    <ul className="shield-injections">
                      {masking.injections.map((item, i) => (
                        <li key={i}><b>{item.kind}</b> — {item.text}</li>
                      ))}
                    </ul>
                  )}
                </>
              )}

              {blocked.map((reason, i) => (
                <p className="shield-blocked" key={i}>{reason}</p>
              ))}
            </section>
          )}

          {maskedScreenshot && (
            <section className="masked-proof-dock" aria-label="Masked snapshot proof">
              <div className="masked-proof-card" role="region" aria-label="Masked Snapshot Proof">
                <div className="masked-proof-header">
                  <div className="masked-proof-badge">
                    <span className="masked-proof-dot" />
                    <span>🛡️ On-Device Redaction</span>
                  </div>
                  <span className="masked-proof-count">{maskedCount} PII Masked</span>
                </div>
                <div className="masked-proof-img-wrap">
                  <img src={maskedScreenshot} alt="Visual Redaction Proof" className="masked-proof-img" />
                  <div className="masked-proof-tag">Visual Masking Proof</div>
                </div>
              </div>
            </section>
          )}
        </section>
      )}

      {activePanel === 'history' && (
        <section className="history-panel" aria-label="Chat history">
          {history.length === 0 ? (
            <div className="details-empty">
              Previous chats will appear here when you open a new page or start a new chat.
            </div>
          ) : (
            history.map((thread) => (
              <article className="history-thread" key={thread.id}>
                <header className="history-head">
                  <div>
                    <h2>{thread.title}</h2>
                    {thread.pageUrl && <p>{thread.pageUrl}</p>}
                  </div>
                  <time dateTime={thread.createdAt}>
                    {new Date(thread.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </time>
                </header>
                <div className="history-messages">
                  {thread.messages.slice(-6).map((message) => (
                    <p className={`history-message ${message.role}`} key={message.id}>
                      {message.text}
                    </p>
                  ))}
                </div>
              </article>
            ))
          )}
        </section>
      )}

      {activePanel === 'chat' && pageLine && (
        <p className={`page-line${hasPage ? '' : ' none'}`}>{pageLine}</p>
      )}

      {activePanel === 'chat' && <form className="composer" onSubmit={handleSubmit}>
        {/* Live voice indicator shown above composer when mic is active */}
        {stt.status === 'listening' && (
          <div className="voice-indicator" aria-live="polite" aria-label="Listening for voice command">
            <span className="voice-dot" />
            <span className="voice-label">Listening…</span>
            {stt.interimText && (
              <span className="voice-interim">{stt.interimText}</span>
            )}
          </div>
        )}

        {/* Error toast from mic (denied, no-speech, etc.) */}
        {voiceError && (
          <div
            className="voice-error"
            role="alert"
            onClick={openMicrophonePermissionTab}
            title="Click to open microphone setup page"
            style={{ cursor: 'pointer' }}
          >
            {voiceError}
          </div>
        )}

        <Input.TextArea
          aria-label="Ask NetraShield"
          autoSize={{ minRows: 1, maxRows: 4 }}
          className={`composer-input${stt.status === 'listening' ? ' composer-input--listening' : ''}`}
          maxLength={240}
          onChange={(event) => onTaskChange(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          placeholder={
            stt.status === 'listening'
              ? 'Bol do… Hindi, Hinglish ya English mein'
              : 'Ask NetraShield to inspect, explain, or guide...'
          }
          value={stt.status === 'listening' && stt.interimText
            ? (task.trim() ? task.trim() + ' ' : '') + stt.interimText
            : task
          }
        />
        <div className="composer-actions">
          <div className="composer-tools">
            <Button className="context-button" icon={<PlusOutlined />} shape="circle" type="text" aria-label="Add context" />

            {/* ---- Microphone button ---- */}
            <Tooltip
              title={
                !stt.isSupported
                  ? 'Voice input not supported in this browser'
                  : stt.status === 'listening'
                  ? 'Click to stop listening'
                  : 'Voice input — Hindi, Hinglish or English'
              }
            >
              <Button
                id="voice-input-btn"
                aria-label={stt.status === 'listening' ? 'Stop voice input' : 'Start voice input'}
                aria-pressed={stt.status === 'listening'}
                className={`mic-button${
                  !stt.isSupported ? ' mic-button--unsupported' : ''
                }${
                  stt.status === 'listening' ? ' mic-button--listening' : ''
                }`}
                disabled={!stt.isSupported || isRunning}
                icon={
                  !stt.isSupported
                    ? <AudioMutedOutlined />
                    : <AudioOutlined />
                }
                onClick={stt.toggle}
                shape="circle"
                type="text"
              />
            </Tooltip>

            <Button
              aria-label="Open Settings"
              className="settings-button"
              icon={<SettingOutlined />}
              onClick={() => setSettingsOpen(true)}
              shape="circle"
              type="text"
            />
          </div>
          <Select
            aria-label="Privacy mode"
            className="mode-select"
            onChange={onModeChange}
            options={modeOptions}
            popupClassName="mode-dropdown"
            value={mode}
            variant="borderless"
          />
          {isRunning ? (
            <Button className="stop-button" size="small" danger onClick={onCancel} aria-label="Stop the task">
              Stop
            </Button>
          ) : (
            <Button
              className="send-button"
              disabled={!task.trim()}
              htmlType="submit"
              icon={<ArrowUpOutlined />}
              shape="circle"
              type="primary"
              aria-label="Send"
            />
          )}
        </div>
      </form>}

      {activePanel === 'chat' && <label className="preapprove-row" title="Remembered across tasks. High-risk actions stay classified and logged either way — this only changes whether you answer up front or one at a time. Authentication codes always need you, live.">
        <input
          type="checkbox"
          checked={preApprove}
          onChange={(event) => onPreApproveChange?.(event.target.checked)}
        />
        <span>Don't ask before sending, posting or paying</span>
      </label>}

      {!extensionReady && <p className="dev-note">Load the built dist folder as an unpacked Chrome extension.</p>}
    </main>
  )
}
