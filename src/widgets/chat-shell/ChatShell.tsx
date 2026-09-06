import { useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { ArrowUpOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons'
import { Button, Input, Select, Typography } from 'antd'
import type { ChatMessage } from '../../features/agent-runner/model'
import { privacyModes } from '../../entities/mode/model'
import type { PrivacyMode } from '../../shared/types/netrashield'
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
