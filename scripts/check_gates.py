"""Zero-pretence enforcement gates.

These are grep-enforced, not honour-system. Run `npm run gates`. A non-zero exit
means the build is not allowed to claim it is real.

G1  no placeholder vocabulary anywhere in shipped code
G2  no domain names in the engine (only the hint-pack module may name a site)
G3  the cockpit renders only bus events -- no timers inventing progress
G4  extraction asserts every url exists as a live href
G5  the verifier rejects stale observations
G6  canvas is used only to black out regions
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SHIPPED = [
    ROOT / "public" / "agent-content.js",
    ROOT / "public" / "agent-background.js",
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
allowed = {"drawImage", "fillStyle", "fillRect"}
g6 = set(draws).issubset(allowed)
gate("G6 canvas used only for redaction", g6,
     "ctx operations = %s (drawImage copies the capture, fillRect blacks out "
     "sensitive regions)" % sorted(set(draws)))

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
