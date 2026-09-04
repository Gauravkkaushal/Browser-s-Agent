import { useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowUpOutlined, BulbOutlined, MessageOutlined, PlusOutlined, SearchOutlined, SettingOutlined } from '@ant-design/icons'
import { Button, Input, Select, Tag, Typography } from 'antd'
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
  onModeChange: (mode: PrivacyMode) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onSuggestion: (suggestion: string) => void
  onTaskChange: (task: string) => void
  suggestions: string[]
}

export function ChatShell({
  extensionReady,
  isRunning,
  messages,
  mode,
  statusText,
  task,
  onModeChange,
  onSubmit,
  onSuggestion,
  onTaskChange,
  suggestions,
}: ChatShellProps) {
  const [settingsOpen, setSettingsOpen] = useState(false)

  const modeOptions = privacyModes.map((privacyMode) => ({
    label: privacyMode.title,
    value: privacyMode.id,
  }))

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
        <div className="header-actions">
          <Tag className="status-tag" bordered={false}>
            {isRunning ? 'Working' : 'Ready'}
          </Tag>
          <Button
            aria-label="Open Settings"
            className="settings-button"
            icon={<SettingOutlined />}
            onClick={() => setSettingsOpen(true)}
            shape="circle"
            size="small"
            type="text"
          />
        </div>
      </section>

      <SettingsDrawer
        onClose={() => setSettingsOpen(false)}
        open={settingsOpen}
      />

      <section className="hero-copy" aria-label="Greeting">
        <Typography.Title level={1}>
          <span>Hello, Gaurav.</span>
          What should we handle on this page?
        </Typography.Title>
        <Typography.Paragraph>
          Ask naturally. Sensitive fields are masked locally before any reasoning starts.
        </Typography.Paragraph>
      </section>

      {(messages.length > 0 || isRunning) && (
        <section className="chat-thread" aria-label="Conversation">
          {messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              {message.text}
            </article>
          ))}
          {isRunning && <article className="message assistant pending">{statusText}</article>}
        </section>
      )}

      <section className="starter-list" aria-label="Suggestions">
        {suggestions.map((suggestion) => (
          <Button
            className="suggestion-button"
            icon={getSuggestionIcon(suggestion)}
            key={suggestion}
            onClick={() => onSuggestion(suggestion)}
            type="text"
          >
            {suggestion}
          </Button>
        ))}
      </section>

      <form className="composer" onSubmit={onSubmit}>
        <Input.TextArea
          aria-label="Ask NetraShield"
          autoSize={{ minRows: 1, maxRows: 4 }}
          className="composer-input"
          maxLength={240}
          onChange={(event) => onTaskChange(event.target.value)}
          placeholder="Ask NetraShield to inspect, explain, or guide..."
          value={task}
        />
        <div className="composer-actions">
          <Button className="context-button" icon={<PlusOutlined />} shape="circle" type="text" aria-label="Add context" />
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

function getSuggestionIcon(suggestion: string) {
  if (suggestion.includes('questions')) {
    return <SearchOutlined />
  }

  if (suggestion.includes('Discuss')) {
    return <MessageOutlined />
  }

  return <BulbOutlined />
}
