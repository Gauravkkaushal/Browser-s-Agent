"""Smoke evaluation harness.

Drives the real server over its real cockpit WebSocket, runs each task in
smoke_tasks.json against the real browser, and decides success from the audit
trail using programmatic criteria only. The model is never asked to grade
itself.

    python -m server.eval.run_smoke            # run everything
    python -m server.eval.run_smoke nav-and-click

Requires: the server running on 8787 and the extension connected.
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

import httpx
import websockets

HERE = Path(__file__).parent
BASE_HTTP = "http://127.0.0.1:8787"
BASE_WS = "ws://127.0.0.1:8787"
TASK_TIMEOUT_S = 300.0


class Metrics:
    def __init__(self) -> None:
        self.steps = 0
        self.actions_proposed = 0
        self.actions_executed = 0
        self.actions_failed = 0
        self.verified = 0
        self.verify_failed = 0
        self.grounding_failures = 0
        self.recoveries = 0
        self.recoveries_handled = 0
        self.model_calls = 0
        self.model_latency_ms: List[float] = []
        self.human_interventions = 0
        self.policy_confirms = 0
        self.login_waits = 0

    def as_dict(self) -> Dict[str, Any]:
        lat = self.model_latency_ms
        return {
            "steps": self.steps,
            "actions_proposed": self.actions_proposed,
            "actions_executed": self.actions_executed,
            "actions_failed": self.actions_failed,
            "action_success_rate": _pct(self.actions_executed, self.actions_proposed),
            "verifications_passed": self.verified,
            "verifications_failed": self.verify_failed,
            "verification_rate": _pct(self.verified, self.verified + self.verify_failed),
            "grounding_failures": self.grounding_failures,
            "recoveries_started": self.recoveries,
            "recoveries_handled": self.recoveries_handled,
            "model_calls": self.model_calls,
            "model_latency_ms_avg": round(sum(lat) / len(lat), 1) if lat else None,
            "human_interventions": self.human_interventions,
            "policy_confirmations": self.policy_confirms,
            "login_waits": self.login_waits,
        }


def _pct(num: int, den: int) -> str:
    return "n/a" if den == 0 else "%.0f%% (%d/%d)" % (100.0 * num / den, num, den)


TERMINAL_STATES = {"COMPLETED", "FAILED", "CANCELLED"}


async def wait_until_idle(timeout_s: float = 90.0) -> None:
    """Block until the server has no task in flight."""
    deadline = asyncio.get_running_loop().time() + timeout_s
    async with httpx.AsyncClient(timeout=10.0) as c:
        while asyncio.get_running_loop().time() < deadline:
            try:
                health = (await c.get(BASE_HTTP + "/health")).json()
                active = health.get("active_task")
                if not active:
                    return
                snap = (await c.get("%s/tasks/%s" % (BASE_HTTP, active))).json()
                if snap.get("state") in TERMINAL_STATES:
                    return
                # Still going: ask it to stop, then keep waiting.
                async with websockets.connect(BASE_WS + "/ws/cockpit") as ws:
                    await asyncio.wait_for(ws.recv(), 10)
                    await ws.send(json.dumps({
                        "v": 1, "type": "TASK_CANCEL", "payload": {"task_id": active},
                    }))
            except (httpx.HTTPError, OSError, ValueError, asyncio.TimeoutError):
                return
            await asyncio.sleep(1.5)


async def run_task(spec: Dict[str, Any]) -> Dict[str, Any]:
    m = Metrics()
    events: List[Dict[str, Any]] = []
    task_id = None
    outcome = "TIMEOUT"
    summary = ""
    error = ""
    started = time.monotonic()

    async with websockets.connect(BASE_WS + "/ws/cockpit", max_size=16 * 1024 * 1024) as ws:
        await asyncio.wait_for(ws.recv(), 10)  # HELLO
        await ws.send(json.dumps({
            "v": 1, "type": "TASK_CREATE", "payload": {"command": spec["command"]},
        }))

        while time.monotonic() - started < TASK_TIMEOUT_S:
            try:
                raw = await asyncio.wait_for(ws.recv(), 20)
            except asyncio.TimeoutError:
                continue
            ev = json.loads(raw)
            t = ev.get("type")
            p = ev.get("payload") or {}
            if ev.get("task_id"):
                task_id = ev["task_id"]
            events.append(ev)
            m.steps = max(m.steps, ev.get("step", 0))

            if t == "ACTION_PROPOSED":
                m.actions_proposed += 1
            elif t == "ACTION_EXECUTED":
                m.actions_executed += 1
            elif t == "ACTION_FAILED":
                m.actions_failed += 1
                if "stale_element" in str(p.get("error", "")):
                    m.grounding_failures += 1
            elif t == "ACTION_VERIFIED":
                m.verified += 1
            elif t == "VERIFICATION_FAILED":
                m.verify_failed += 1
            elif t == "RECOVERY_STARTED":
                m.recoveries += 1
            elif t == "RECOVERY_COMPLETED" and p.get("handled"):
                m.recoveries_handled += 1
            elif t == "MODEL_CALL_COMPLETED":
                m.model_calls += 1
                if p.get("latency_ms"):
                    m.model_latency_ms.append(p["latency_ms"])
            elif t == "LOGIN_REQUIRED":
                m.login_waits += 1
            elif t == "CONFIRMATION_REQUESTED":
                m.policy_confirms += 1
                m.human_interventions += 1
                # The harness is the human here. It approves only when the task
                # spec says the confirmation gate is what is under test, and
                # otherwise declines -- it never approves a payment silently.
                if "CONFIRMATION_REQUESTED" in (spec.get("success", {}).get("requires_events") or []):
                    print("      [gate reached] declining, the gate itself is what is under test")
                await ws.send(json.dumps({
                    "v": 1, "type": "CONFIRMATION_DENIED", "payload": {"task_id": task_id},
                }))
            elif t == "TASK_COMPLETED":
                outcome = "COMPLETED"
                summary = p.get("summary", "")
                break
            elif t == "TASK_FAILED":
                outcome = "FAILED"
                error = p.get("error", "")
                break
            elif t == "TASK_CANCELLED":
                outcome = "CANCELLED"
                break
            elif t == "ERROR":
                outcome = "ERROR"
                error = p.get("error", "")
                break

    audit_text = ""
    trace: List[Dict[str, Any]] = []
    extracted: List[Dict[str, Any]] = []
    if task_id:
        async with httpx.AsyncClient(timeout=20.0) as c:
            r = await c.get("%s/tasks/%s/audit" % (BASE_HTTP, task_id))
            if r.status_code == 200:
                audit_text = r.text
            r = await c.get("%s/tasks/%s/trace" % (BASE_HTTP, task_id))
            if r.status_code == 200:
                trace = r.json()["url_transitions"]
            r = await c.get("%s/tasks/%s" % (BASE_HTTP, task_id))
            if r.status_code == 200:
                extracted = r.json().get("extracted", [])

    # ---- programmatic success criteria -----------------------------------
    crit = spec.get("success", {})
    checks: List[Dict[str, Any]] = []

    def check(name: str, ok: bool, detail: str) -> None:
        checks.append({"check": name, "ok": ok, "detail": detail})

    if "url_reached" in crit:
        needle = crit["url_reached"]
        hit = any(needle in t["url"] for t in trace)
        check("url_reached", hit,
              "%s in %d observed url transitions" % (needle, len(trace)))

    if "summary_contains" in crit:
        needle = str(crit["summary_contains"]).lower()
        blob = (summary or "").lower().replace(",", "")
        check("summary_contains", needle in blob, "looking for %r in the final summary" % needle)

    if "min_extracted_items" in crit:
        n = len(extracted)
        check("min_extracted_items", n >= crit["min_extracted_items"],
              "%d items extracted, needed >= %d" % (n, crit["min_extracted_items"]))

    if "requires_events" in crit:
        for want in crit["requires_events"]:
            hit = any(e.get("type") == want for e in events)
            check("event:" + want, hit, "present in the live event stream" if hit else "never emitted")

    for needle in crit.get("audit_must_not_contain", []):
        leaked = needle in audit_text
        check("no_leak:" + needle[:24], not leaked,
              "raw value found in the audit file" if leaked else "never appears in the audit file")

    for needle in crit.get("audit_must_contain", []):
        check("audit_contains:" + needle[:24], needle in audit_text,
              "present in the audit file")

    if "max_steps" in crit:
        check("within_step_budget", m.steps <= crit["max_steps"],
              "%d steps, budget %d" % (m.steps, crit["max_steps"]))

    check("terminal_state", outcome in ("COMPLETED", "CANCELLED"),
          "task ended %s" % outcome)

    passed = all(c["ok"] for c in checks) and bool(checks)

    return {
        "id": spec["id"],
        "command": spec["command"],
        "task_id": task_id,
        "outcome": outcome,
        "passed": passed,
        "summary": summary,
        "error": error,
        "elapsed_s": round(time.monotonic() - started, 1),
        "checks": checks,
        "metrics": m.as_dict(),
        "url_transitions": trace,
    }


async def main() -> int:
    spec_file = json.loads((HERE / "smoke_tasks.json").read_text(encoding="utf-8"))
    wanted = sys.argv[1:]
    tasks = [t for t in spec_file["tasks"] if not wanted or t["id"] in wanted]

    async with httpx.AsyncClient(timeout=10.0) as c:
        try:
            health = (await c.get(BASE_HTTP + "/health")).json()
        except httpx.HTTPError as exc:
            print("Server is not reachable on %s (%s)." % (BASE_HTTP, exc))
            print("Start it with:  npm run server")
            return 2
    if not health["browser_connected"]:
        print("The Chrome extension is not connected.")
        print("Load dist/ as an unpacked extension and open a normal http(s) tab.")
        return 2

    print("=" * 78)
    print("SMOKE EVALUATION  |  %d task(s)  |  models: %s"
          % (len(tasks), " > ".join(health["model_chain"])))
    print("=" * 78)

    results = []
    for spec in tasks:
        # One browser, one task at a time. Starting the next before the server
        # has finished the previous makes every remaining task fail for a
        # bookkeeping reason rather than a real one.
        await wait_until_idle()
        print("\n>>> %s" % spec["id"])
        print("    %s" % spec["command"])
        res = await run_task(spec)
        results.append(res)
        print("    outcome: %s in %ss over %d steps"
              % (res["outcome"], res["elapsed_s"], res["metrics"]["steps"]))
        for c in res["checks"]:
            print("      [%s] %-32s %s" % ("PASS" if c["ok"] else "FAIL", c["check"], c["detail"]))
        if res["url_transitions"]:
            print("    real url transitions:")
            for t in res["url_transitions"]:
                print("      %s  step %-2s  %s" % (t["ts"][11:19], t["step"], t["url"][:96]))
        if res["error"]:
            print("    error: %s" % res["error"][:200])

    out = HERE / "last_run.json"
    out.write_text(json.dumps(results, indent=2), encoding="utf-8")

    npassed = sum(1 for r in results if r["passed"])
    print("\n" + "=" * 78)
    print("RESULT: %d/%d tasks passed every criterion" % (npassed, len(results)))
    for r in results:
        print("  %-28s %-10s %s" % (r["id"], "PASS" if r["passed"] else "FAIL", r["task_id"] or ""))
    print("full report: %s" % out)
    print("=" * 78)
    return 0 if npassed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
