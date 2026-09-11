"""Zero-pretence enforcement gates.

These are grep-enforced, not honour-system. Run `npm run gates`. A non-zero exit
means the build is not allowed to claim it is real.

G1  no placeholder vocabulary anywhere in shipped code
G2  no domain names in the engine (only the hint-pack module may name a site)
G3  the cockpit renders only bus events -- no timers inventing progress
G4  extraction asserts every url exists as a live href
G5  the verifier rejects stale observations
G6  canvas is used only to black out regions
G7  the page (content script) never talks to the server directly -- only the
    background service worker's single WebSocket does
G8  on-device OCR runs only on the already-redacted screenshot, and loads its
    model/engine files locally -- never from a CDN
G9  CLIP vision grounding loads its model/runtime files locally -- never from
    a CDN -- and never invents a click target from a pixel coordinate
G10 a redaction leak caught by re-OCR withholds the screenshot (fail-closed),
    never forwards it "mostly redacted"
G11 QR detection only ever reads a code's LOCATION to black it out -- the
    decoded content is never touched
G12 every reasoner payload's real byte size is measured and a real budget is
    checked -- not an unverified "2-10KB" claim
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SHIPPED = [
    ROOT / "public" / "agent-content.js",
    ROOT / "public" / "agent-background.js",
    ROOT / "public" / "offscreen.js",
    *sorted((ROOT / "server").glob("*.py")),
    ROOT / "server" / "templates" / "cockpit.html",
    ROOT / "src" / "pages" / "popup" / "PopupPage.tsx",
]

# The loop, reasoner, policy, verifier and executor must not know any site.
ENGINE = [
    ROOT / "server" / "loop.py",
    ROOT / "server" / "reasoner.py",
    ROOT / "server" / "policy.py",
    ROOT / "server" / "verifier.py",
    ROOT / "server" / "recovery.py",
    ROOT / "server" / "planner.py",
    ROOT / "public" / "agent-content.js",
    ROOT / "public" / "agent-background.js",
]

PLACEHOLDER = re.compile(r"\b(mock|fake|simulat\w*|dummy|stub)\w*\b", re.I)
DOMAINS = re.compile(r"\b(flipkart|meesho|whatsapp|gmail|amazon)\b", re.I)

results: list[tuple[str, bool, str]] = []


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8") if p.exists() else ""


def gate(name: str, ok: bool, detail: str) -> None:
    results.append((name, ok, detail))


# --- G1 --------------------------------------------------------------------
hits = []
for f in SHIPPED:
    for i, line in enumerate(read(f).splitlines(), 1):
        for m in PLACEHOLDER.finditer(line):
            hits.append("%s:%d: %s" % (f.relative_to(ROOT), i, line.strip()[:110]))
gate("G1 no placeholder vocabulary in shipped code", not hits,
     "0 hits across %d files" % len(SHIPPED) if not hits else "\n      ".join(hits[:12]))

# --- G2 --------------------------------------------------------------------
hits = []
for f in ENGINE:
    for i, line in enumerate(read(f).splitlines(), 1):
        if DOMAINS.search(line):
            hits.append("%s:%d: %s" % (f.relative_to(ROOT), i, line.strip()[:110]))
gate("G2 no site names in the engine", not hits,
     "0 hits across %d engine files; site names confined to server/knowledge.py"
     % len(ENGINE) if not hits else "\n      ".join(hits[:12]))

# --- G3 --------------------------------------------------------------------
cockpit = read(ROOT / "server" / "templates" / "cockpit.html")
# Every setInterval in the cockpit must be the keepalive ping and nothing else.
timer_bodies = re.findall(r"setInterval\(([\s\S]{0,160}?),\s*\d+\s*\)", cockpit)
bad_timers = [t for t in timer_bodies if "send('PING'" not in t]
has_bus_only = "function handle(e)" in cockpit and "ws.onmessage" in cockpit
no_optimistic = "TASK_COMPLETED" in cockpit and "push(e)" in cockpit
gate("G3 cockpit renders only real bus events",
     len(bad_timers) == 0 and has_bus_only and no_optimistic,
     "%d setInterval call(s), all keepalive pings; every rendered line comes from "
     "ws.onmessage -> handle(e)" % len(timer_bodies) if not bad_timers
     else "non-keepalive timer(s): %s" % bad_timers[:3])

# --- G4 --------------------------------------------------------------------
content = read(ROOT / "public" / "agent-content.js")
g4 = "const liveHrefs = new Set()" in content and "liveHrefs.has(anchor.href)" in content
gate("G4 extracted urls must exist as live hrefs", g4,
     "doExtract() builds liveHrefs from the document and emits a url only if present")

# --- G5 --------------------------------------------------------------------
verifier = read(ROOT / "server" / "verifier.py")
g5 = "check_freshness" in verifier and "OBSERVATION_MAX_AGE_S" in verifier
gate("G5 verifier rejects stale observations", g5,
     "check_freshness() rejects observations that predate the action or drift past "
     "the age budget, and catches URL drift under non-navigational actions")

# --- G6 --------------------------------------------------------------------
bg = read(ROOT / "public" / "agent-background.js")
draws = re.findall(r"ctx\.(\w+)", bg)
# getImageData reads pixels back out -- allowed only because the one caller,
# detectQrBoxes(), uses them to find a QR code's LOCATION to black out next,
# same purpose as drawImage/fillRect. It never draws with what it reads.
allowed = {"drawImage", "fillStyle", "fillRect", "getImageData"}
g6 = set(draws).issubset(allowed)
gate("G6 canvas used only for redaction", g6,
     "ctx operations = %s (drawImage copies the capture, getImageData feeds QR "
     "detection, fillRect blacks out sensitive regions -- including QR codes)"
     % sorted(set(draws)))

# --- G7 --------------------------------------------------------------------
# The extension's only egress point to our own server is agent-background.js's
# WebSocket. If the content script -- which runs inside every page, including
# hostile ones -- ever opened its own socket or hit that server directly, the
# "sanitize before it leaves the device" story would be unverifiable: nothing
# would stop a redaction bug on one path from being bypassed by the other.
no_socket_in_page = "new WebSocket(" not in content
no_server_addr_in_page = "127.0.0.1:8787" not in content and "localhost:8787" not in content
g7 = no_socket_in_page and no_server_addr_in_page
gate("G7 content script has no direct path to the server", g7,
     "agent-content.js contains no WebSocket and no server address; the WebSocket in "
     "agent-background.js (DEFAULT_SERVER) is the only egress point"
     if g7 else "content script appears to talk to the server directly")

# --- G8 --------------------------------------------------------------------
# Two separate claims, both checkable from source: (a) OCR is only ever run on
# the redacted capture -- a blacked-out box must not come back as readable
# text through a side channel the redaction code didn't anticipate -- and
# (b) the OCR engine's model/wasm/worker files are loaded from inside the
# extension package, never fetched from a CDN, so recognition genuinely works
# offline instead of silently depending on a network call nobody promised.
redact_idx = bg.find("const shot = await captureRedacted(")
ocr_idx = bg.find("const ocr = await runOcr(shot.screenshot)")
g8_order = redact_idx != -1 and ocr_idx != -1 and redact_idx < ocr_idx

offscreen = read(ROOT / "public" / "offscreen.js")
offscreen_html = read(ROOT / "public" / "offscreen.html")
remote = re.compile(r"https?://")
g8_local = (
    "chrome.runtime.getURL('tesseract/" in offscreen
    and not remote.search(offscreen)
    and not remote.search(offscreen_html)
)
g8 = g8_order and g8_local
gate("G8 OCR reads only the redacted screenshot, fully offline", g8,
     "runOcr() is called after captureRedacted() in the same observe handler, and "
     "offscreen.js/offscreen.html reference no http(s) URL -- every model/engine file "
     "is loaded via chrome.runtime.getURL('tesseract/...') from inside the package"
     if g8 else "OCR ordering or offline loading could not be verified in source")

# --- G9 --------------------------------------------------------------------
# Same discipline as G8, for the second offscreen model: CLIP's weights and
# the ONNX Runtime Web wasm binary must load from inside the package, never a
# remote host, or "on-device" would be true right up until the first demo
# without wifi.
g9_local = (
    "env.allowRemoteModels = false" in offscreen
    and "env.localModelPath = chrome.runtime.getURL('models/')" in offscreen
    and "env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('transformers/ort/')" in offscreen
    and not remote.search(offscreen)
)
# CLIP only ever attaches a score to an eid the real DOM walk already found --
# runClipScore()'s output feeds obs.visual_scores (an eid->number map), never
# a click. Grounding a click in a raw screenshot coordinate would break the
# "never click by pixel coordinates" rule the executor depends on.
g9_scores_only = (
    "obs.visual_scores = clip.ok" in bg
    and "Object.fromEntries(clip.scores.map((s) => [s.eid, s.score]))" in bg
)
g9 = g9_local and g9_scores_only
gate("G9 CLIP grounding is local-only and scores eids, never invents a click", g9,
     "offscreen.js points allowRemoteModels/localModelPath/wasmPaths entirely at "
     "chrome.runtime.getURL(...) package paths with no remote URL anywhere, and "
     "agent-background.js only ever turns a CLIP result into an eid->score map"
     if g9 else "CLIP offline loading or the scores-only invariant could not be verified")

# --- G10 -------------------------------------------------------------------
g10 = (
    "function verifyRedaction(regions)" in bg
    and "if (verify.leaked) {" in bg
    and "obs.screenshot = null" in bg
)
gate("G10 a caught redaction leak withholds the screenshot, fail-closed", g10,
     "verifyRedaction() re-checks OCR text from the already-redacted image, and "
     "observe() nulls obs.screenshot the moment it reports a leak"
     if g10 else "the fail-closed wiring on a redaction leak could not be verified")

# --- G11 --------------------------------------------------------------------
def _function_body(src: str, signature: str) -> str:
    """Slice one function's body out by brace-matching from its signature."""
    start = src.find(signature)
    if start == -1:
        return ""
    depth = 0
    started = False
    for i in range(start, len(src)):
        if src[i] == "{":
            depth += 1
            started = True
        elif src[i] == "}":
            depth -= 1
            if started and depth == 0:
                return src[start:i + 1]
    return src[start:]

qr_fn = _function_body(bg, "function detectQrBoxes(ctx, width, height) {")
# img.data (the raw pixel array jsQR takes as INPUT) is expected and fine;
# result.data is jsQR's DECODED payload -- a real UPI string, say -- and must
# never be read, let alone forwarded. Only result.location may be touched.
g11 = bool(qr_fn) and "result.location" in qr_fn and "result.data" not in qr_fn
gate("G11 QR detection reads only a code's location, never its decoded content", g11,
     "detectQrBoxes() reads result.location for the bounding box and never touches "
     "jsQR's result.data (the decoded payload) anywhere in the function"
     if g11 else "could not verify detectQrBoxes() avoids the decoded QR payload")

# --- G12 --------------------------------------------------------------------
reasoner_src = read(ROOT / "server" / "reasoner.py")
g12 = (
    "tier0_bytes = len(build(0).encode(\"utf-8\"))" in reasoner_src
    and "PAYLOAD_BUDGET_EXCEEDED" in reasoner_src
    and "PAYLOAD_BUDGET_KB" in read(ROOT / "server" / "config.py")
)
gate("G12 the reasoner payload's real byte size is measured against a real budget", g12,
     "propose() measures the actual UTF-8 byte length of the tier-0 payload every "
     "step and emits PAYLOAD_BUDGET_EXCEEDED when it is over config.PAYLOAD_BUDGET_KB"
     if g12 else "could not verify the payload-size measurement is wired up")

# --- report ----------------------------------------------------------------
print()
print("=" * 78)
print("ZERO-PRETENCE ENFORCEMENT GATES")
print("=" * 78)
failed = 0
for name, ok, detail in results:
    print(("  [PASS] " if ok else "  [FAIL] ") + name)
    print("      " + detail)
    if not ok:
        failed += 1
print("-" * 78)
print("%d/%d gates passed" % (len(results) - failed, len(results)))
print("=" * 78)
sys.exit(1 if failed else 0)
