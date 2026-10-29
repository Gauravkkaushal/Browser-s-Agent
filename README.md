# NetraShield — Privacy-Preserving On-Device Visual Perception Browser Agent

[![CI Status](https://img.shields.io/badge/build-passing-brightgreen)](#verification-and-testing)
[![Tests](https://img.shields.io/badge/tests-347%20passed-success)](#verification-and-testing)
[![Zero-Pretence Gates](https://img.shields.io/badge/gates-12%20verified-blue)](#the-12-zero-pretence-gates)
[![Manifest V3](https://img.shields.io/badge/Chrome%20Extension-MV3-orange)](#system-architecture)
[![SIH 26171](https://img.shields.io/badge/SIH%202024-Problem%2026171%20(ISRO)-blueviolet)](https://www.sih.gov.in/)

> **Built for Smart India Hackathon (SIH) Problem Statement 26171 (ISRO)**: Autonomous web agent that perceives, grounds, and acts directly inside your browser while cryptographically and structurally guaranteeing that raw Personal Identifiable Information (PII), credentials, passwords, and unmasked screenshots never leave the client device.

---

## Central Invariant

$$\textbf{Raw PII, credentials, passwords, raw DOM text, and unsanitized screenshots must NEVER leave the device.}$$

Every outward transmission to the reasoning server is either:
1. An on-device **sanitized semantic payload** with PII replaced by typed surrogates (`[REDACTED:AADHAAR_01]`, `[REDACTED:PAN_01]`, etc.), or
2. A **fail-closed redacted bitmap** where all sensitive bounding boxes and QR codes are blacked out on a local canvas, re-verified via offline Tesseract OCR before release, and withheld if any residual leak is detected.

---

## System Architecture

NetraShield uses a closed-loop perception-action cycle operating across Chrome's Manifest V3 boundary and a local Python reasoning brain:

```
User Command (Voice / Text)
    │
    ▼
PLANNER ────────────────► Ordered Plan Steps (Goals, not fragile selectors)
    │
    ▼
┌──────────────────────────────── The Loop ────────────────────────────────┐
│                                                                          │
│  1. PERCEIVE   Content Script walks live DOM                             │
│       │        → Deduce roles, geometry & compute stable NID hashes      │
│       │        → On-device regex & Verhoeff/Luhn checksum masking        │
│       ▼                                                                  │
│  2. MASK       Service Worker captures tab bitmap via canvas             │
│       │        → Blackout sensitive boxes + jsQR code locations          │
│       ▼                                                                  │
│  3. VERIFY     Offscreen WASM Worker (Zero Network I/O)                  │
│       │        → Re-OCR redacted image with Tesseract.js (fail-closed)   │
│       │        → Local MobileCLIP-S0 visual grounding for element scores │
│       ▼                                                                  │
│  4. REASON     Local FastAPI Reasoning Server (127.0.0.1:8787)           │
│       │        → Sanitizer datamarks & neutralizes prompt injections     │
│       │        → LLM Adapter proposes one validated ActionProposal      │
│       ▼                                                                  │
│  5. POLICY     Deterministic Policy Engine (Python)                      │
│       │        → Low-Risk: Auto-execute                                  │
│       │        → High-Risk: Block on Human Approval in Cockpit/Popup    │
│       ▼                                                                  │
│  6. EXECUTE    Content Script / Service Worker applies action            │
│       │        → Real clicks, contenteditable typing, tab navigation     │
│       ▼                                                                  │
│  7. VERIFY     Fresh Observation checks predicted change                 │
│       └───────────────────────► (Success? Next step : Recover & Retry)   │
└──────────────────────────────────────────────────────────────────────────┘
    │
    ▼
TASK_COMPLETED (with verifiable audit trail) | TASK_FAILED
```

---

## Key Features

- **Multi-Modal On-Device Perception**:
  - Live DOM walking with stable element identity (`eid` ephemeral ID + `nid` FNV-1a structure hash).
  - Built-in multi-lingual Speech-to-Text supporting English, Hindi, and Hinglish via Web Speech API in the extension popup.
- **Fail-Closed Privacy Pipeline**:
  - 10 core PII detectors: Aadhaar (Verhoeff verified), PAN, Payment Cards (Luhn verified), UPI IDs, Email, Indian Phone numbers, Voter IDs, Driving Licenses, GSTIN, and DOB.
  - Protected field shielding: Password and PIN values are zeroed at perception time (`[PROTECTED INPUT] len=N`).
  - QR Code detection: Automatically blacks out payment/auth QR codes using bundled `jsQR`.
  - Secondary re-OCR audit: Any visual mask failure withholds the entire screenshot (`obs.screenshot = null`).
- **Local AI Grounding & Offline Runtime**:
  - Offline Tesseract.js WASM for OCR.
  - Offline MobileCLIP-S0 ONNX model in ONNX Runtime Web for zero-shot visual element grounding.
- **Security & Prompt Injection Defense**:
  - Interleaved datamarking (`·1·`, `·2·`) and instruction-neutralization rules defending against untrusted web page prompt injections.
  - Authenticated session isolation over WebSocket protocols (`auth.<token>`).
  - Deterministic policy gate with human-in-the-loop approvals for financial or destructive actions.

---

## 5-Minute Quickstart

### Prerequisites
- **Node.js**: v20+ (tested on v24)
- **Python**: v3.11+ (tested on v3.13)
- **Google Chrome**: v116+ (Manifest V3 support)

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/Gauravkkaushal/Browser-s-Agent.git
cd Browser-s-Agent

# Install Node dependencies
npm install

# Setup Python environment
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
python -m pip install -r server/requirements.txt
```

### 2. Configure Environment
Copy `.env.example` to `.env` and set at least one model API key:
```bash
cp .env.example .env
```
Supported providers (in rotation order):
- `GEMINI_API_KEYS` (Default reasoner, fast multimodal response)
- `GROQ_API_KEY` (Ultra-low latency fallback)
- `OPENROUTER_API_KEYS`
- `OPENAI_API_KEY`
- `OLLAMA_HOST` (Optional local offline model)

### 3. Build & Run
```bash
# Build popup and extension assets
npm run build

# Start the reasoning server (binds to 127.0.0.1:8787)
npm run server
```

### 4. Load Extension in Chrome
1. Open `chrome://extensions` in Google Chrome.
2. Enable **Developer mode** (toggle in top right).
3. Click **Load unpacked** and select the [`dist/`](file:///C:/Users/gaura/Desktop/SIH/SIH/dist) directory.
4. Open the cockpit at [http://127.0.0.1:8787/cockpit](http://127.0.0.1:8787/cockpit) or click the NetraShield extension icon.
5. In the extension popup, click the detach icon to run NetraShield in a persistent standalone window beside your browsing tab.

---

## Verification and Testing

NetraShield enforces rigorous verification before any release:

```bash
# Run TypeScript/React unit & characterization tests (149 tests)
npm test

# Run Python server & policy tests (198 tests)
npm run test:py

# Run Zero-Pretence architectural enforcement gates (12 gates)
npm run gates

# Build production extension distribution
npm run build
```

---

## The 12 Zero-Pretence Gates

The gates in [`scripts/check_gates.py`](file:///C:/Users/gaura/Desktop/SIH/SIH/scripts/check_gates.py) are grep-enforced architectural invariants, not an honour system:

| Gate | Name | Architectural Invariant |
| :--- | :--- | :--- |
| **G1** | No Placeholder Vocabulary | No `mock`, `fake`, `simulated`, or `dummy` terms in shipped code. |
| **G2** | No Site Names in Engine | Loop, planner, and policy are domain-agnostic; site advice is confined to `server/knowledge.py`. |
| **G3** | Bus Events Only | Cockpit renders purely from real WebSocket event streams; zero optimistic UI fabrication. |
| **G4** | Live Href Extraction | Every extracted link must exist as an actual `href` in the observed DOM. |
| **G5** | Stale Observation Rejection | Actions are verified against fresh observations; URL drift causes immediate recovery. |
| **G6** | Canvas Exclusively for Redaction | Offscreen canvas is used only to black out sensitive boxes, never to synthesize content. |
| **G7** | Content Script Air-Gap | Content script has zero network capabilities; all egress routes through the service worker. |
| **G8** | Offline On-Device OCR | Tesseract WASM runs only on already-redacted bitmaps from local extension assets. |
| **G9** | Local CLIP Grounding | MobileCLIP-S0 scores candidates locally; no raw screenshots or clicks are generated from coordinates. |
| **G10** | Fail-Closed Redaction Leak Defense | If secondary re-OCR detects any PII leak on a redacted image, the screenshot is strictly withheld. |
| **G11** | Location-Only QR Processing | QR scanning extracts only bounding box coordinates for blackout; payload data is never read. |
| **G12** | Measured Payload Budget | Server measures exact UTF-8 byte length against strict budget limits every step. |

---

## Repository Structure

```
├── contracts/                     # Single source of truth contracts & schemas
├── docs/
│   ├── adr/                       # Architectural Decision Records (0001-0005)
│   ├── architecture/              # C4 Architecture Specification (Context, Container, Component)
│   ├── audit/                     # Phase 0 Baseline Audit & Findings Table
│   └── metrics/                   # Baseline metrics, latencies, and budgets
├── public/
│   ├── manifest.json              # Chrome Manifest V3 configuration
│   ├── agent-background.js        # Service Worker: session isolation, transport, capture
│   ├── agent-content.js           # Content Script: DOM walking, PII detection, action executor
│   ├── offscreen.html / .js       # Offscreen worker: Tesseract WASM + MobileCLIP ONNX
│   ├── models/                    # Bundled MobileCLIP-S0 ONNX model weights
│   ├── tesseract/                 # Bundled Tesseract WASM & language data
│   ├── transformers/              # Bundled ONNX Runtime Web WASM binaries
│   └── jsqr/                      # Bundled jsQR detection library
├── server/
│   ├── main.py                    # FastAPI app: /ws/agent, /ws/cockpit, health & fixtures
│   ├── loop.py                    # Closed-loop FSM & task orchestration
│   ├── sanitizer.py               # Prompt injection defense & datamarking
│   ├── policy.py                  # Deterministic allow / confirm / deny engine
│   ├── llm.py                     # Provider gateway & key rotation (Gemini, Groq, OpenRouter)
│   ├── verifier.py                # Action outcome & freshness verification
│   ├── browser_bridge.py          # Awaitable RPC over extension WebSocket
│   ├── fixtures/                  # Benchmark test pages (PII, scholarship, payment, shop)
│   └── tests/                     # Pytest suite (198 tests)
├── src/
│   ├── app/                       # Extension root layout & styling
│   ├── pages/popup/               # Extension popup entry page
│   ├── widgets/chat-shell/        # Cockpit UI, speech-to-text, and visual proof inspector
│   ├── widgets/settings/          # Engine selection & connection drawer
│   ├── features/agent-runner/     # WebSocket client & event stream narration
│   ├── shared/                    # Types, storage, and utility libraries
│   └── test/                      # Vitest suite & golden fixtures (149 tests)
└── scripts/
    ├── check_gates.py             # 12-Gate verification script
    └── generate-icons.mjs         # Extension icon generator
```

---

## Evaluation Fixtures

NetraShield includes deterministic benchmark fixtures to verify compliance and policy enforcement:
- **Scholarship Verification**: [http://127.0.0.1:8787/fixtures/govt-scholarship](http://127.0.0.1:8787/fixtures/govt-scholarship) (Aadhaar Verhoeff validation & high-risk submission policy).
- **Job Application**: [http://127.0.0.1:8787/fixtures/job-application-demo](http://127.0.0.1:8787/fixtures/job-application-demo) (Local profile fill without exposing secrets to LLM).
- **Prompt Injection Defense**: [http://127.0.0.1:8787/fixtures/prompt-injection-demo](http://127.0.0.1:8787/fixtures/prompt-injection-demo) (Adversarial order neutralization).
- **Payment Shield**: [http://127.0.0.1:8787/fixtures/payment](http://127.0.0.1:8787/fixtures/payment) (Credit card masking & QR blackout).

---

## Security & Disclosure

NetraShield is built with a zero-leak philosophy. If you discover a vulnerability or data leakage path, please review our threat model in [`docs/architecture/ARCHITECTURE.md`](file:///C:/Users/gaura/Desktop/SIH/SIH/docs/architecture/ARCHITECTURE.md) and [`docs/audit/AUDIT.md`](file:///C:/Users/gaura/Desktop/SIH/SIH/docs/audit/AUDIT.md).
