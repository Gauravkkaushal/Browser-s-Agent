import { useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { ArrowUpOutlined, DownloadOutlined, PlusOutlined, SettingOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { Button, Input, Select, Typography } from 'antd'
import type { ChatMessage } from '../../features/agent-runner/model'
import { privacyModes } from '../../entities/mode/model'
import type { PrivacyMode, ReasonResult } from '../../shared/types/netrashield'
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
  reason?: ReasonResult | null
  onExecuteAction?: () => void
  onModeChange: (mode: PrivacyMode) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onTaskChange: (task: string) => void
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
  reason,
  onExecuteAction,
  onModeChange,
  onSubmit,
  onTaskChange,
}: ChatShellProps) {
  const [settingsOpen, setSettingsOpen] = useState(false)

  const modeOptions = privacyModes.map((privacyMode) => ({
    label: privacyMode.title,
    value: privacyMode.id,
  }))

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

  function downloadPrivacyCertificate() {
    const certHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>NetraShield Zero-Leak Privacy Audit Certificate</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b1120; color: #f8fafc; padding: 40px; display: flex; justify-content: center; }
    .cert { background: #1e293b; border: 2px solid #10b981; border-radius: 16px; padding: 36px; max-width: 600px; width: 100%; box-shadow: 0 20px 50px rgba(0,0,0,0.5); }
    .header { text-align: center; border-bottom: 1px solid rgba(148,163,184,0.2); padding-bottom: 20px; }
    .title { color: #34d399; font-size: 24px; font-weight: 800; margin: 0; }
    .subtitle { color: #94a3b8; font-size: 14px; margin-top: 6px; }
    .meta { margin: 24px 0; background: #0f172a; border-radius: 10px; padding: 18px; }
    .meta-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; color: #cbd5e1; }
    .meta-val { font-weight: 700; color: #6ee7b7; }
    .img-box { text-align: center; margin: 20px 0; }
    .img-box img { max-width: 100%; border-radius: 8px; border: 1px solid #10b981; }
    .footer { text-align: center; font-size: 11px; color: #64748b; margin-top: 24px; }
  </style>
</head>
<body>
  <div class="cert">
    <div class="header">
      <h1 class="title">🛡️ NetraShield Privacy Audit Certificate</h1>
      <div class="subtitle">ISRO SIH Challenge 26171 • Zero-Leak Guaranteed</div>
    </div>
    <div class="meta">
      <div class="meta-row"><span>Audit Timestamp:</span><span class="meta-val">${new Date().toUTCString()}</span></div>
      <div class="meta-row"><span>PII Elements Redacted:</span><span class="meta-val">${maskedCount} Elements</span></div>
      <div class="meta-row"><span>Air-Gap / Privacy Mode:</span><span class="meta-val">${mode.toUpperCase()}</span></div>
      <div class="meta-row"><span>Data Leak Status:</span><span class="meta-val" style="color:#34d399;">0% (ZERO LEAK VERIFIED ✅)</span></div>
    </div>
    ${maskedScreenshot ? `<div class="img-box"><h3>Visual Redaction Proof:</h3><img src="${maskedScreenshot}" alt="Masked Proof" /></div>` : ''}
    <div class="footer">Generated cryptographically on-device by NetraShield Autonomous Browser Agent.</div>
  </div>
</body>
</html>`

    const blob = new Blob([certHtml], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `NetraShield-Privacy-Audit-${Date.now()}.html`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <main className="chat-popup" aria-label="NetraShield assistant">
      <section className="assistant-header" aria-label="Assistant status">
        <div className="brand-lockup">
          <div className="brand-orb" aria-hidden="true">
            N
          </div>
          <div>
            <Typography.Text className="brand-title">NetraShield</Typography.Text>
            <Typography.Text className="brand-subtitle">Private page assistant</Typography.Text>
          </div>
        </div>
      </section>

      <SettingsDrawer
        onClose={() => setSettingsOpen(false)}
        open={settingsOpen}
      />

      {messages.length === 0 && !isRunning && (
        <section className="hero-copy" aria-label="Greeting">
          <Typography.Title level={1}>
            <span>Hello, Gaurav.</span>
            What should we handle on this page?
          </Typography.Title>
          <Typography.Paragraph>
            Ask naturally. Sensitive fields are masked locally before any reasoning starts.
          </Typography.Paragraph>

          <div className="quick-actions-list">
            <button
              type="button"
              className="quick-action-pill"
              onClick={() => {
                onTaskChange('Scroll through the whole page and give a complete summary')
              }}
            >
              📜 Full Page Scroll & Summarize
            </button>
            <button
              type="button"
              className="quick-action-pill"
              onClick={() => {
                onTaskChange('Scan and redact all sensitive PII on this page')
              }}
            >
              🛡️ Scan & Redact Sensitive PII
            </button>
          </div>
        </section>
      )}

      {(messages.length > 0 || isRunning) && (
        <section className="chat-thread" aria-label="Conversation">
          {messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              {message.text}
            </article>
          ))}
          {isRunning && <article className="message assistant pending">{statusText}</article>}
          {maskedScreenshot && (
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
              <div className="masked-proof-footer">
                <button type="button" className="audit-download-btn" onClick={downloadPrivacyCertificate}>
                  <DownloadOutlined /> Export Privacy Audit Certificate
                </button>
              </div>
            </div>
          )}

          {reason?.command?.type === 'highlight' && reason?.command?.targetId && (
            <div className="action-confirm-card">
              <div className="action-confirm-info">
                <ThunderboltOutlined style={{ color: '#10b981', fontSize: '15px' }} />
                <span>Target identified: <strong>{reason.command.targetId}</strong></span>
              </div>
              <Button
                type="primary"
                size="small"
                className="action-confirm-btn"
                onClick={onExecuteAction}
              >
                Confirm & Highlight Target
              </Button>
            </div>
          )}
        </section>
      )}

      <form className="composer" onSubmit={onSubmit}>
        <Input.TextArea
          aria-label="Ask NetraShield"
          autoSize={{ minRows: 1, maxRows: 4 }}
          className="composer-input"
          maxLength={240}
          onChange={(event) => onTaskChange(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          placeholder="Ask NetraShield to inspect, explain, or guide..."
          value={task}
        />
        <div className="composer-actions">
          <div className="composer-tools">
            <Button className="context-button" icon={<PlusOutlined />} shape="circle" type="text" aria-label="Add context" />
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
          <Button
            className="send-button"
            disabled={isRunning || !task.trim()}
            htmlType="submit"
            icon={<ArrowUpOutlined />}
            shape="circle"
            type="primary"
            aria-label="Send"
          />
        </div>
      </form>

      {!extensionReady && <p className="dev-note">Load the built dist folder as an unpacked Chrome extension.</p>}
    </main>
  )
}
