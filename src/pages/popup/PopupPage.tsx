import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Input, Space, Tag, Typography } from 'antd'

const { Text, Title } = Typography

const DEFAULT_SERVER = 'ws://127.0.0.1:8787/ws/agent'

type Status = {
  connected: boolean
  session_id?: string
  current_tab?: number | null
}

/**
 * The popup is a launcher, not a control surface.
 *
 * All task control lives in the cockpit (served by the reasoning server) so
 * that there is exactly one place where events are rendered, and that place
 * renders nothing except what arrives on the event bus. The popup only reports
 * transport health and opens the cockpit.
 */
export function PopupPage() {
  const [status, setStatus] = useState<Status | null>(null)
  const [server, setServer] = useState(DEFAULT_SERVER)
  const [saved, setSaved] = useState(false)

  const refresh = useCallback(() => {
    chrome.runtime?.sendMessage?.({ type: 'AGENT_STATUS' }, (res?: Status) => {
      if (chrome.runtime.lastError) {
        setStatus({ connected: false })
        return
      }
      setStatus(res ?? { connected: false })
    })
  }, [])

  useEffect(() => {
    chrome.storage?.local?.get('agentServerUrl', (v) => {
      if (v?.agentServerUrl) setServer(v.agentServerUrl)
    })
    refresh()
    const id = setInterval(refresh, 2000)
    return () => clearInterval(id)
  }, [refresh])

  const cockpitUrl = server
    .replace(/^ws:/, 'http:')
    .replace(/^wss:/, 'https:')
    .replace(/\/ws\/agent.*$/, '/cockpit')

  return (
    <div style={{ padding: 18, width: 360, fontFamily: 'system-ui, sans-serif' }}>
      <Title level={5} style={{ marginTop: 0, marginBottom: 4 }}>
        Browser Agent
      </Title>
      <Text type="secondary" style={{ fontSize: 12 }}>
        Closed-loop agent running in this Chrome profile.
      </Text>

      <div style={{ margin: '16px 0' }}>
        {status?.connected ? (
          <Tag color="green">connected to the reasoning server</Tag>
        ) : (
          <Tag color="red">not connected</Tag>
        )}
        {status?.session_id ? (
          <div style={{ marginTop: 6 }}>
            <Text code style={{ fontSize: 11 }}>
              {status.session_id}
            </Text>
          </div>
        ) : null}
      </div>

      {!status?.connected ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14, fontSize: 12 }}
          message="Server unreachable"
          description="Start it with: uvicorn server.main:app --port 8787"
        />
      ) : null}

      <Space.Compact style={{ width: '100%', marginBottom: 10 }}>
        <Input
          size="small"
          value={server}
          onChange={(e) => {
            setServer(e.target.value)
            setSaved(false)
          }}
          placeholder={DEFAULT_SERVER}
        />
        <Button
          size="small"
          onClick={() => {
            chrome.runtime.sendMessage({ type: 'AGENT_SET_SERVER', url: server }, () => {
              setSaved(true)
              refresh()
            })
          }}
        >
          Save
        </Button>
      </Space.Compact>
      {saved ? (
        <Text type="success" style={{ fontSize: 11 }}>
          Saved — reconnecting.
        </Text>
      ) : null}

      <Space style={{ marginTop: 14, width: '100%' }} direction="vertical">
        <Button type="primary" block onClick={() => chrome.tabs.create({ url: cockpitUrl })}>
          Open cockpit
        </Button>
        <Button
          block
          onClick={() => chrome.runtime.sendMessage({ type: 'AGENT_RECONNECT' }, refresh)}
        >
          Reconnect
        </Button>
      </Space>
    </div>
  )
}
