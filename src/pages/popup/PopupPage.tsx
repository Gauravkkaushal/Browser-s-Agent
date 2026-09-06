import { useCallback, useEffect, useState } from 'react'
import './popup.css'

const DEFAULT_SERVER = 'ws://127.0.0.1:8787/ws/agent'

type Status = { connected: boolean; session_id?: string; current_tab?: number | null }
type Health = {
  browser_connected: boolean
  model_chain: string[]
  active_task: string | null
  guards?: Record<string, number>
}

const QUICK_TASKS = [
  { label: 'Summarise this page', cmd: 'Read the page I am on and summarise the key points' },
  { label: 'Check my inbox', cmd: 'Open Gmail and tell me what is in my inbox — who wrote, the subject, and what each one needs from me' },
  { label: 'Compare prices', cmd: 'Find good running shoes under 2000 rupees across two shopping sites and tell me the cheapest good option' },
]

export function PopupPage() {
  const [status, setStatus] = useState<Status | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [server, setServer] = useState(DEFAULT_SERVER)
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState(false)

  const httpBase = server.replace(/^ws/, 'http').replace(/\/ws\/agent.*$/, '')

  const refresh = useCallback(() => {
    chrome.runtime?.sendMessage?.({ type: 'AGENT_STATUS' }, (res?: Status) => {
      if (chrome.runtime.lastError) return setStatus({ connected: false })
      setStatus(res ?? { connected: false })
    })
    fetch(httpBase + '/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null))
  }, [httpBase])

  useEffect(() => {
    chrome.storage?.local?.get('agentServerUrl', (v) => {
      if (v?.agentServerUrl) setServer(v.agentServerUrl)
    })
    refresh()
    const id = setInterval(refresh, 2500)
    return () => clearInterval(id)
  }, [refresh])

  const openCockpit = (prefill?: string) => {
    const url = httpBase + '/cockpit' + (prefill ? '#' + encodeURIComponent(prefill) : '')
    chrome.tabs.create({ url })
  }

  const serverUp = health !== null
  const linked = !!status?.connected && !!health?.browser_connected

  return (
    <div className="pop">
      <header className="pop-head">
        <div className="mark" aria-hidden="true">
          <span className={'dot' + (linked ? ' live' : '')} />
        </div>
        <div className="head-text">
          <h1>Browser Agent</h1>
          <p>Observe → reason → act → verify, in this Chrome profile</p>
        </div>
      </header>

      <section className="rail">
        <Stat ok={serverUp} label="Server" value={serverUp ? 'online' : 'offline'} />
        <Stat ok={linked} label="Extension" value={linked ? 'linked' : 'not linked'} />
        <Stat
          ok={!!health?.model_chain?.length}
          label="Models"
          value={health?.model_chain?.[0] ?? '—'}
          title={health?.model_chain?.join(' → ')}
        />
      </section>

      {!serverUp && (
        <div className="alert">
          <strong>The reasoning server is not running.</strong>
          <code>npm run server</code>
        </div>
      )}
      {serverUp && !linked && (
        <div className="alert warn">
          <strong>Extension not linked.</strong>
          <span>Open any normal http(s) page, then press Reconnect.</span>
        </div>
      )}
      {health?.active_task && (
        <div className="alert busy">
          <strong>A task is running.</strong>
          <span>{health.active_task}</span>
        </div>
      )}

      <button className="btn primary big" onClick={() => openCockpit()}>
        Open cockpit
      </button>

      <section className="quick">
        <h2>Start something</h2>
        {QUICK_TASKS.map((t) => (
          <button key={t.label} className="quick-item" onClick={() => openCockpit(t.cmd)}>
            <span className="q-label">{t.label}</span>
            <span className="q-cmd">{t.cmd}</span>
          </button>
        ))}
      </section>

      <CredentialPanel httpBase={httpBase} />

      <footer className="pop-foot">
        <button
          className="btn ghost"
          onClick={() => chrome.runtime.sendMessage({ type: 'AGENT_RECONNECT' }, refresh)}
        >
          Reconnect
        </button>
        <button className="btn ghost" onClick={() => setEditing((v) => !v)}>
          {editing ? 'Close' : 'Server…'}
        </button>
        {status?.session_id && <code className="sess">{status.session_id.slice(0, 14)}</code>}
      </footer>

      {editing && (
        <div className="server-edit">
          <input
            value={server}
            spellCheck={false}
            onChange={(e) => {
              setServer(e.target.value)
              setSaved(false)
            }}
          />
          <button
            className="btn primary"
            onClick={() =>
              chrome.runtime.sendMessage({ type: 'AGENT_SET_SERVER', url: server }, () => {
                setSaved(true)
                refresh()
              })
            }
          >
            Save
          </button>
          {saved && <span className="ok-note">Saved — reconnecting</span>}
        </div>
      )}
    </div>
  )
}

type Slot = { slot: string; site: string; label: string; kind: string }

/**
 * Saved sign-ins.
 *
 * What you type here goes from this popup to the vault file on this machine and
 * nowhere else. The reasoning model is shown the slot NAMES only — never a
 * value — and the policy layer refuses to fill a slot on any site other than
 * the one it is bound to.
 */
function CredentialPanel({ httpBase }: { httpBase: string }) {
  const [slots, setSlots] = useState<Slot[] | null>(null)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [site, setSite] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  const load = useCallback(() => {
    fetch(httpBase + '/credentials')
      .then((r) => r.json())
      .then((d) => setSlots(d.slots ?? []))
      .catch(() => setSlots(null))
  }, [httpBase])

  useEffect(load, [load])

  const save = () => {
    if (!name.trim() || !site.trim() || (!username && !password)) {
      setNote('Give it a name, a site, and at least one field.')
      return
    }
    setBusy(true)
    setNote('')
    const fields: Record<string, string> = {}
    if (username) fields.username = username
    if (password) fields.password = password
    fetch(httpBase + '/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), match_url: site.trim(), label: name.trim(), fields }),
    })
      .then((r) => r.json())
      .then((d) => {
        setSlots(d.slots ?? [])
        setUsername('')
        setPassword('')
        setName('')
        setSite('')
        setOpen(false)
        setNote('Saved. The value never leaves this machine.')
      })
      .catch(() => setNote('Could not reach the server.'))
      .finally(() => setBusy(false))
  }

  const remove = (entry: string) => {
    fetch(httpBase + '/credentials/' + encodeURIComponent(entry), { method: 'DELETE' })
      .then((r) => r.json())
      .then((d) => setSlots(d.slots ?? []))
      .catch(() => undefined)
  }

  if (slots === null) return null
  const entries = Array.from(new Set(slots.map((s) => s.slot.split('.')[0])))

  return (
    <section className="creds">
      <h2>
        Saved sign-ins
        <button className="mini" onClick={() => setOpen((v) => !v)}>{open ? 'Cancel' : '+ Add'}</button>
      </h2>

      {entries.length === 0 && !open && (
        <p className="cred-empty">
          None yet. Add one and the agent can sign you in without ever seeing the value.
        </p>
      )}

      {entries.map((entry) => {
        const mine = slots.filter((s) => s.slot.startsWith(entry + '.'))
        return (
          <div className="cred-row" key={entry}>
            <div className="cred-main">
              <span className="cred-name">{entry}</span>
              <span className="cred-site">only on {mine[0]?.site}</span>
              <span className="cred-slots">{mine.map((s) => s.slot.split('.')[1]).join(' · ')}</span>
            </div>
            <button className="mini danger" onClick={() => remove(entry)} title="Remove">×</button>
          </div>
        )
      })}

      {open && (
        <div className="cred-form">
          <input placeholder="name (e.g. lms)" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="site it works on (e.g. lms.kiet.edu)" value={site} onChange={(e) => setSite(e.target.value)} />
          <input placeholder="username" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
          <input placeholder="password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save sign-in'}
          </button>
          <p className="cred-note">
            Stored on this machine only. The model sees the slot name, never the value,
            and it is refused on any site but the one above.
          </p>
        </div>
      )}
      {note && <p className="cred-note ok">{note}</p>}
    </section>
  )
}

function Stat({ ok, label, value, title }: {
  ok: boolean; label: string; value: string; title?: string
}) {
  return (
    <div className={'stat' + (ok ? ' ok' : '')} title={title}>
      <span className="s-label">{label}</span>
      <span className="s-value">{value}</span>
    </div>
  )
}
