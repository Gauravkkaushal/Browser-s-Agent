import { useEffect, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Divider,
  Drawer,
  Input,
  Radio,
  Space,
  Tag,
  Typography,
  message,
} from 'antd'
import {
  ApiOutlined,
  CheckCircleOutlined,
  CloudServerOutlined,
  CodeOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import type { ReasoningEngine, UserSettings } from '../../shared/types/netrashield'
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../../shared/lib/settingsStorage'
import './SettingsDrawer.css'

type SettingsDrawerProps = {
  open: boolean
  onClose: () => void
  onSettingsChanged?: (settings: UserSettings) => void
}

export function SettingsDrawer({ open, onClose, onSettingsChanged }: SettingsDrawerProps) {
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS)
  const [testingServer, setTestingServer] = useState(false)
  const [serverStatus, setServerStatus] = useState<'idle' | 'online' | 'offline'>('idle')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      loadSettings().then((loaded) => {
        setSettings(loaded)
        setServerStatus('idle')
      })
    }
  }, [open])

  async function handleEngineChange(engine: ReasoningEngine) {
    const updated = { ...settings, reasoningEngine: engine }
    setSettings(updated)
    await saveSettings(updated)
    onSettingsChanged?.(updated)
  }

  async function handleServerUrlChange(url: string) {
    const updated = { ...settings, serverUrl: url }
    setSettings(updated)
  }

  async function handleSave() {
    setSaving(true)
    try {
      const updated = await saveSettings(settings)
      onSettingsChanged?.(updated)
      message.success('Settings saved successfully')
    } catch {
      message.error('Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  async function testServerConnection() {
    setTestingServer(true)
    setServerStatus('idle')
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 3000)
      const res = await fetch(settings.serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ping: true, task: 'health-check' }),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)
      if (res.ok) {
        setServerStatus('online')
        message.success('Server is reachable!')
      } else {
        setServerStatus('offline')
        message.warning(`Server responded with status: ${res.status}`)
      }
    } catch {
      setServerStatus('offline')
      message.error('Server is unreachable. Make sure demo-server is running.')
    } finally {
      setTestingServer(false)
    }
  }

  return (
    <Drawer
      className="settings-drawer"
      closeIcon={<span style={{ color: '#94a3b8' }}>✕</span>}
      onClose={onClose}
      open={open}
      placement="right"
      title={
        <div className="settings-drawer-header">
          <SafetyCertificateOutlined className="header-icon" />
          <div>
            <div className="title-text">NetraShield Settings</div>
            <div className="subtitle-text">Reasoning Engine & Privacy Options</div>
          </div>
        </div>
      }
      width={360}
    >
      <div className="settings-content">
        {/* Reasoning Engine Section */}
        <section className="settings-section">
          <Typography.Text className="section-label">Reasoning Engine</Typography.Text>
          <Typography.Paragraph className="section-hint">
            Choose where task intent classification and element selection takes place.
          </Typography.Paragraph>

          <Radio.Group
            className="engine-radio-group"
            onChange={(e) => handleEngineChange(e.target.value)}
            value={settings.reasoningEngine}
          >
            <Radio.Button className="engine-card" value="auto">
              <div className="card-header">
                <Space>
                  <ThunderboltOutlined className="card-icon" />
                  <span className="card-title">Auto (Recommended)</span>
                </Space>
                <Tag color="cyan">Balanced</Tag>
              </div>
              <div className="card-desc">
                Executes local ONNX inference on-device first. Automatically falls back to sanitized server reasoning if local model confidence is low.
              </div>
            </Radio.Button>

            <Radio.Button className="engine-card" value="onnx">
              <div className="card-header">
                <Space>
                  <CodeOutlined className="card-icon onnx-icon" />
                  <span className="card-title">Local ONNX (Air-Gapped)</span>
                </Space>
                <Tag color="green">Zero Leak</Tag>
              </div>
              <div className="card-desc">
                100% on-device WebAssembly ML. Zero network requests sent. Strict privacy for high-security environments.
              </div>
            </Radio.Button>

            <Radio.Button className="engine-card" value="server">
              <div className="card-header">
                <Space>
                  <CloudServerOutlined className="card-icon server-icon" />
                  <span className="card-title">Server Reasoning</span>
                </Space>
                <Tag color="purple">Remote API</Tag>
              </div>
              <div className="card-desc">
                Sends sanitized, masked page graphs directly to the designated reasoning endpoint for external LLM reasoning.
              </div>
            </Radio.Button>
          </Radio.Group>
        </section>

        <Divider className="settings-divider" />

        {/* Server URL Configuration */}
        <section className="settings-section">
          <Typography.Text className="section-label">Reasoning Server URL</Typography.Text>
          <Typography.Paragraph className="section-hint">
            Endpoint used when Server or Auto fallback mode is engaged.
          </Typography.Paragraph>

          <div className="server-input-group">
            <Input
              disabled={settings.reasoningEngine === 'onnx'}
              onChange={(e) => handleServerUrlChange(e.target.value)}
              placeholder="http://localhost:8787/reason"
              prefix={<ApiOutlined style={{ color: '#64748b' }} />}
              value={settings.serverUrl}
            />
            <Button
              disabled={settings.reasoningEngine === 'onnx'}
              loading={testingServer}
              onClick={testServerConnection}
              type="default"
            >
              Test
            </Button>
          </div>

          {serverStatus === 'online' && (
            <Alert
              className="server-alert"
              icon={<CheckCircleOutlined />}
              message="Server is online & responding"
              showIcon
              type="success"
            />
          )}
          {serverStatus === 'offline' && (
            <Alert
              className="server-alert"
              message="Server unreachable at this address"
              showIcon
              type="error"
            />
          )}
        </section>

        <Divider className="settings-divider" />

        {/* Model & System Specifications */}
        <section className="settings-section">
          <Typography.Text className="section-label">Active Model Specs</Typography.Text>
          <div className="specs-card">
            <div className="spec-row">
              <span className="spec-key">Architecture</span>
              <span className="spec-val">Linear Softmax (ONNX 17)</span>
            </div>
            <div className="spec-row">
              <span className="spec-key">Runtime</span>
              <span className="spec-val">WASM / ONNX Runtime Web</span>
            </div>
            <div className="spec-row">
              <span className="spec-key">Intent Classes</span>
              <span className="spec-val">8 (Login, Pay, Save, Send, Search, Delete, Navigate, Download)</span>
            </div>
            <div className="spec-row">
              <span className="spec-key">Features / Vocab</span>
              <span className="spec-val">90 Token Vectors</span>
            </div>
            <div className="spec-row">
              <span className="spec-key">Air-Gap Status</span>
              <Badge
                status={settings.reasoningEngine === 'onnx' ? 'success' : 'processing'}
                text={settings.reasoningEngine === 'onnx' ? 'Strictly Local' : 'Local + Telemetry'}
              />
            </div>
          </div>
        </section>

        <div className="settings-actions">
          <Button block loading={saving} onClick={handleSave} type="primary">
            Save Changes
          </Button>
        </div>
      </div>
    </Drawer>
  )
}
