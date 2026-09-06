# Browser Agent — a real computer-use agent for your own Chrome

A closed-loop agent that drives **your** Chrome profile: it observes the live
page, reasons about it with an LLM, validates every proposed action through a
deterministic policy layer, executes it against the real DOM, and then verifies
against a *fresh* observation that the intended change actually happened.

There is no scripted walkthrough and no per-site automation. One perception,
grounding, action, policy, verification and recovery engine drives every site.

```
User command
    │
    ▼
PLANNER ──────────► short ordered plan (goals, not clicks)
    │
    ▼
┌───────────────────────── the loop ─────────────────────────┐
│                                                            │
│  OBSERVE   content script walks the live DOM               │
│     │      → redacts PII before anything leaves the page   │
│     ▼                                                      │
│  REASON    one observation in, ONE ActionProposal out      │
│     │      (Pydantic-validated; the model cannot invent    │
│     ▼       a verb or a selector)                          │
│  POLICY    pure Python. allow / confirm / deny             │
│     │      high-risk ⇒ blocks on a human in the cockpit    │
│     ▼                                                      │
│  EXECUTE   real click / real typing / real navigation      │
│     │                                                      │
│     ▼                                                      │
│  VERIFY    FRESH observation; did the predicted change     │
│     │      actually occur? no ⇒ RECOVER, re-ground, retry  │
│     └──────────────────► back to OBSERVE                   │
└────────────────────────────────────────────────────────────┘
    │
    ▼
COMPLETED (with the real answer) | FAILED (with the real error)
```

---

## Why an extension and not Playwright

Playwright or Puppeteer would spawn a *fresh* browser. That loses the logged-in
sessions in your own profile — which for a chat or mail task is the entire
capability, not a detail. It also adds a relay hop on every single call and is
more fingerprintable.

Running as an extension inside the user's own Chrome preserves those sessions,
looks like an ordinary profile, and keeps every action visible on screen.
`chrome.debugger` (CDP) is escalated to for exactly two things: capturing
screenshots and dismissing native JavaScript dialogs.

---

## Setup

**Requirements:** Python 3.11+, Node 20+, Chrome 116+.

```bash
npm install
python -m pip install -r server/requirements.txt
npm run build
```

Put your model credentials in `.env` (copy `.env.example`). Any one of these is
enough:

| Variable | Notes |
|---|---|
| `GROQ_API_KEY` | Fast and free-tier friendly. Default primary. |
| `OPENROUTER_API_KEYS` | Comma-separated; keys rotate automatically on 402/429. |
| `OPENAI_API_KEY` | Direct OpenAI. |
| `GEMINI_API_KEY` | Uses `response_mime_type: application/json`. |
| `OLLAMA_HOST` | Local fallback, `format: json`. |

`LLM_PROVIDER` sets the chain order (default `groq,openrouter,openai,gemini,ollama`).

**Run it:**

```bash
npm run server
```

Then load the extension: `chrome://extensions` → Developer mode → **Load
unpacked** → select `dist/`. Open the cockpit at
<http://127.0.0.1:8787/cockpit>. The `browser:` pill turns green when the
service worker's WebSocket connects.

Type a command into the cockpit and watch Chrome do it.

---

## The four things that are easy to get wrong

**1. The service worker must not fall asleep.** Chrome keeps an MV3 service
worker alive while a WebSocket is open *only if messages are exchanged inside
every 30-second window*. The worker pings at 20s (`KEEPALIVE_MS`) and reconnects
with a 1.5–3s backoff; a reconnect reuses the stored `agentSessionId`, so the
server treats it as the same session and an in-flight task simply resumes.

**2. Chat and mail composers are not `<input>`s.** They are `contenteditable`,
and `element.value = x` silently does nothing. The executor focuses the node,
collapses the selection to the end, and uses
`document.execCommand('insertText', …)` — which fires the real `beforeinput` /
`input` events those editors listen for — with a synthetic `InputEvent`
fallback. Either way it **reads the field back** and reports whether the text
actually landed. A typing action whose readback does not contain the text is
reported as failed, never as done.

**3. Login walls are correct behaviour, not failure.** The walker sets
`page_state.login_wall` from *generic* signals — a large canvas plus scan/QR
wording with no populated conversation list, or a visible password field / a
sign-in URL shape with an identifier field. On detection the FSM emits
`LOGIN_REQUIRED`, enters `WAITING_FOR_LOGIN`, shows a cockpit banner, and polls
a fresh observation every 3s. When the wall disappears it emits `LOGIN_DETECTED`
and resumes the task **at the same step**. After 300s it fails honestly.

**4. Site knowledge is advice, never control flow.** `server/knowledge.py` is
the only module in the repo permitted to name a domain. Its hint packs are
pasted into the *reasoner's prompt* as plain English. The loop, policy layer,
verifier, recovery handlers and executor never see them and never branch on a
hostname — enforced by gate G2. Delete every pack and the agent still runs; it
just has to discover each interface from the observation alone.

---

## Contracts

**Every WebSocket message, both directions:**

```json
{ "v":1, "type":"<EventType>", "ts":"ISO", "task_id":"…|null",
  "step":N, "seq":N, "payload":{} }
```

**Element identity.** Each observation stamps `data-agent-eid="e{n}"` (ephemeral,
what the model sees) and `data-agent-nid` — an 8-hex FNV-1a hash of
`tag|id|aria-label|text-prefix32|WxH` (stable across re-renders). The model only
ever names an `eid`; the server attaches `nid`, accessible name and CSS path
from the observation itself. Resolution order is **eid → nid → exact text
signature → css path**. A miss is reported as `stale_element` and the loop
re-observes and re-reasons — never one fragile selector.

**Policy classes** (deterministic, in `server/policy.py`):

- **LOW, auto-allow** — navigate, open/switch tab, back/forward, scroll, hover,
  focus, wait, extract, screenshot, keypress, select, closing an agent-owned
  tab, ordinary clicks and ordinary typing.
- **HIGH, always confirm** — `submit`; any click whose accessible name matches
  `/pay|payment|checkout|buy now|place order|purchase|order now|send\b|delete|remove|confirm|transfer|post\b/i`;
  typing into a password/OTP/CVV/card/Aadhaar/UPI-PIN field; any action on a
  `/checkout|pay|billing|bank|upi/` URL.
- **DENY** — any verb outside the whitelist; closing a tab the agent did not open.

Every decision is logged with `{decision, risk, rules_fired[], reason}`.

**Guards.** `MAX_STEPS=60`, 600s wall clock, 120s confirmation timeout →
cancelled, 300s login timeout → failed, 2 retries per action, and 3 consecutive
failed verifications → failed.

---

## Privacy

Redaction happens **in the page, before anything is serialised**. Nine PII
patterns (card, Aadhaar, PAN, GSTIN, Voter ID, DL, UPI, email, phone) rewrite
every name, text and value to `[REDACTED:TYPE]`. Password / OTP / CVV / card /
Aadhaar / UPI-PIN field *values* never leave at all — the server receives only
`[PROTECTED INPUT] len=N`.

Prices are deliberately **not** redacted. They are task data, and an agent that
cannot read a price cannot compare two shops.

Screenshots are captured via `chrome.tabs.captureVisibleTab`, drawn to an
`OffscreenCanvas`, and every `sensitive_boxes` region is filled black (dpr-scaled)
before the JPEG is encoded. The canvas is used for nothing else — gate G6 greps
for exactly that. Screenshots are taken only on a confirmation request, every
`SCREENSHOT_EVERY` steps, and on finish.

---

## Verification and evidence

Every task writes a JSONL audit to `~/.browser-agent/tasks/<task_id>.jsonl`
containing every event, real URL transitions and real element counts.

```bash
curl http://127.0.0.1:8787/tasks/<task_id>/trace   # url transitions only
curl http://127.0.0.1:8787/tasks/<task_id>/audit   # the whole stream
```

```bash
npm run gates      # G1-G6 anti-pretence gates (grep-enforced)
npm test           # 29 JS tests (walker, redaction, keepalive, manifest)
npm run test:py    # 32 Python tests (schema, policy, verifier, knowledge)
npm run smoke      # end-to-end suite against the real browser
```

The gates are not honour-system:

| Gate | What it enforces |
|---|---|
| G1 | No placeholder vocabulary anywhere in shipped code. |
| G2 | No site names in the engine; domains confined to `knowledge.py`. |
| G3 | The cockpit's only timer is the keepalive ping — nothing invents progress. |
| G4 | Every extracted URL must exist as a live `href` in the current DOM. |
| G5 | The verifier rejects observations that are stale or URL-mismatched. |
| G6 | Canvas is used only to black out regions, never to draw. |

---

## Layout

```
public/
  manifest.json            MV3, <all_urls>, chrome 116+
  agent-content.js         walker + PII redaction + page executor
  agent-background.js      service worker: WebSocket, keepalive, tabs, screenshots
server/
  schemas.py               Envelope, Observation, ActionProposal, PolicyDecision
  events.py                event bus → cockpit + JSONL audit
  llm.py                   model gateway, provider chain, key rotation
  planner.py  reasoner.py  the two model roles
  policy.py                deterministic allow / confirm / deny
  verifier.py              expectations + generic signals + freshness
  recovery.py              overlay / stale / slow-load / error-page handlers
  loop.py                  the FSM and task registry
  browser_bridge.py        awaitable RPC over the extension's WebSocket
  knowledge.py             hint packs — the ONLY file allowed to name a site
  main.py                  FastAPI, /ws/agent, /ws/cockpit
  templates/cockpit.html   operator UI (renders bus events only)
  fixtures/                payment / pii / shop test pages
  eval/                    smoke suite with programmatic success criteria
src/pages/popup/           launcher: transport status + open cockpit
scripts/check_gates.py     G1-G6
```

---

## Known limitations — read this before demoing

- **One browser, one task at a time.** The registry holds many tasks but refuses
  to start a second while one is running; they would fight over the same tabs.
- **Single frame.** The content script does not run in iframes
  (`all_frames: false`). Anything inside a cross-origin iframe — many embedded
  payment forms — is invisible to the agent.
- **`chrome://`, the Web Store, and PDF viewers block extensions entirely.** The
  agent reports this as a real error rather than pretending.
- **Extraction needs a repeated priced group.** `extract` looks for ≥3
  structurally similar sibling containers each holding a currency match. A
  single-product page, or a results grid that lazy-renders below the fold, will
  return nothing until the agent scrolls.
- **Heavy sites can outrun a single observation.** On a page that re-renders
  continuously, an `eid` can go stale between observation and click. That path
  is handled (`stale_element` → re-observe → re-reason) but costs a step.
- **The login gate detects a wall, it cannot sign in.** By design. It will never
  type a credential.
- **Verification is behavioural, not semantic.** It can confirm that a message
  bubble containing your text appeared; it cannot confirm the recipient was the
  person you meant. That is what the approval modal is for.
- **Anti-bot walls (CAPTCHA, interstitials) stop the agent.** It reports them
  and stops. It does not attempt to solve them.
- **Rate limits are real.** A long multi-site task is dozens of model calls. On
  a free tier, expect throttling; the chain falls through to the next provider
  and every fallback is visible as `MODEL_CALL_COMPLETED` with
  `fallbacks_before > 0`.
