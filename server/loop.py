"""The closed loop and its state machine.

    PLANNING -> OBSERVING -> REASONING -> ACTION_PROPOSED -> POLICY_CHECK
             -> [WAITING_FOR_CONFIRMATION] -> EXECUTING -> VERIFYING
             -> [RECOVERING] -> back to OBSERVING
             -> COMPLETED | FAILED | CANCELLED
    plus WAITING_FOR_LOGIN, entered whenever the live page shows a login wall.

Every transition emits a real event. Nothing in this file knows what site it is
driving: grep it for a domain name and you will find none.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any, Dict, List, Optional

from . import config, planner, reasoner, recovery, verifier
from .browser_bridge import BridgeError, bridge
from .events import bus
from .llm import ModelError
from .policy import evaluate, redact_preview
from .schemas import (
    BROWSER_VERBS, ActionProposal, Observation, Plan, TERMINAL_VERBS, now_iso,
)


class TaskCancelled(Exception):
    pass


class Task:
    """One running task. Owns its own FSM state and audit trail."""

    def __init__(self, command: str) -> None:
        self.task_id = "task_" + uuid.uuid4().hex[:10]
        self.command = command
        self.state = "PLANNING"
        self.step = 0
        self.started = time.monotonic()
        self.plan: Optional[Plan] = None
        self.history: List[Dict[str, Any]] = []
        self.extracted: List[Dict[str, Any]] = []
        self.consecutive_verify_failures = 0
        self.cancelled = False
        self.summary: str = ""
        self.error: str = ""
        self._confirm_future: Optional[asyncio.Future] = None
        self._pending_confirmation: Optional[Dict[str, Any]] = None

    # -- state --------------------------------------------------------------
    async def set_state(self, state: str, detail: str = "") -> None:
        self.state = state
        await bus.emit("STATE_CHANGED", {"state": state, "detail": detail},
                       task_id=self.task_id, step=self.step)

    def snapshot(self) -> Dict[str, Any]:
        return {
            "task_id": self.task_id,
            "command": self.command,
            "state": self.state,
            "step": self.step,
            "elapsed_s": round(time.monotonic() - self.started, 1),
            "plan": self.plan.model_dump() if self.plan else None,
            "history": self.history[-30:],
            "extracted": self.extracted[:40],
            "summary": self.summary,
            "error": self.error,
            "pending_confirmation": self._pending_confirmation,
        }

    # -- confirmation -------------------------------------------------------
    def confirm(self, granted: bool) -> bool:
        if self._confirm_future is None or self._confirm_future.done():
            return False
        self._confirm_future.set_result(granted)
        return True

    def cancel(self) -> None:
        self.cancelled = True
        if self._confirm_future is not None and not self._confirm_future.done():
            self._confirm_future.set_result(False)

    def _guard(self) -> None:
        if self.cancelled:
            raise TaskCancelled()

    # -- observation --------------------------------------------------------
    async def observe(self, screenshot: bool = False) -> Observation:
        self._guard()
        obs = await bridge.observe(task_id=self.task_id, screenshot=screenshot)
        await bus.emit("OBSERVATION_RECEIVED", {
            "url": obs.url,
            "title": obs.title,
            "interactive_count": len(obs.interactive_elements),
            "element_count": obs.dom_summary.get("element_count"),
            "walk_ms": obs.walk_ms,
            "overlay_present": obs.page_state.overlay_present,
            "loading": obs.page_state.loading,
            "login_wall": obs.page_state.login_wall.model_dump() if obs.page_state.login_wall else None,
            "pii_redactions": obs.pii_redactions,
            "sensitive_boxes": len(obs.sensitive_boxes),
            "tabs": [t.model_dump() for t in obs.tabs],
            "screenshot": obs.screenshot,
            "observed_at": obs.observed_at,
        }, task_id=self.task_id, step=self.step)
        return obs

    # -- login gate ---------------------------------------------------------
    async def wait_for_login(self, obs: Observation) -> Observation:
        """A login wall is correct behaviour, not a failure. Pause and resume."""
        wall = obs.page_state.login_wall
        await self.set_state("WAITING_FOR_LOGIN", wall.hint if wall else "")
        await bus.emit("LOGIN_REQUIRED", {
            "app": wall.app if wall else "generic",
            "kind": wall.kind if wall else "credential",
            "hint": wall.hint if wall else "Sign in to continue.",
            "url": obs.url,
            "message": "Sign in in the browser window. The task resumes automatically.",
            "timeout_s": config.LOGIN_TIMEOUT_S,
        }, task_id=self.task_id, step=self.step)

        deadline = time.monotonic() + config.LOGIN_TIMEOUT_S
        while time.monotonic() < deadline:
            self._guard()
            await asyncio.sleep(config.LOGIN_POLL_S)
            try:
                fresh = await bridge.observe(task_id=self.task_id)
            except BridgeError:
                continue
            if fresh.page_state.login_wall is None:
                await bus.emit("LOGIN_DETECTED", {
                    "url": fresh.url,
                    "waited_s": round(config.LOGIN_TIMEOUT_S - (deadline - time.monotonic()), 1),
                    "message": "Signed in. Resuming the task at the same step.",
                }, task_id=self.task_id, step=self.step)
                return fresh

        raise RuntimeError(
            "login wall still present after %.0fs -- nobody signed in, so the task "
            "cannot continue" % config.LOGIN_TIMEOUT_S
        )

    # -- execution ----------------------------------------------------------
    async def execute(self, action: ActionProposal, obs: Observation) -> Dict[str, Any]:
        self._guard()
        await bus.emit("ACTION_EXECUTING", {
            "action_id": action.action_id,
            "action": action.action,
            "preview": redact_preview(action),
        }, task_id=self.task_id, step=self.step)

        verb = action.action
        args: Dict[str, Any] = {}
        if verb in BROWSER_VERBS:
            if verb == "navigate":
                args = {"url": action.params.url}
            elif verb == "open_tab":
                args = {"url": action.params.url}
            elif verb in ("switch_tab", "close_tab"):
                args = {"tab_id": action.target.tab_id}
            elif verb == "screenshot":
                args = {"tab_id": action.target.tab_id}
            return await bridge.request(verb, args, task_id=self.task_id)

        payload = action.model_dump()
        return await bridge.request("act", {"action": payload}, task_id=self.task_id)

    # -- one full cycle -----------------------------------------------------
    async def step_once(self, obs: Observation) -> Optional[Observation]:
        """observe -> reason -> policy -> execute -> verify. Returns next obs."""
        self.step += 1

        # --- REASONING ---
        await self.set_state("REASONING")
        try:
            action = await reasoner.propose(
                self.plan.objective if self.plan else self.command,
                self.plan, obs, self.history, self.task_id, self.step, self.extracted,
            )
        except ModelError as exc:
            raise RuntimeError("the reasoner could not produce a valid action: %s" % exc)

        await bus.emit("ACTION_PROPOSED", {
            "action_id": action.action_id,
            "action": action.action,
            "target": action.target.model_dump(),
            "params": action.params.model_dump(exclude_none=True),
            "reason": action.reason,
            "confidence": action.confidence,
            "preview": redact_preview(action),
        }, task_id=self.task_id, step=self.step)

        # --- TERMINAL VERBS ---
        if action.action in TERMINAL_VERBS:
            if action.action == "finish":
                self.summary = action.params.summary or action.reason
                raise _Finished()
            self.error = action.params.error or action.reason
            raise RuntimeError(self.error)

        # --- POLICY ---
        await self.set_state("POLICY_CHECK")
        decision = evaluate(action, obs)
        if decision.decision == "deny":
            await bus.emit("POLICY_DENIED", {
                "action_id": action.action_id, "action": action.action,
                "decision": decision.model_dump(),
            }, task_id=self.task_id, step=self.step)
            self.history.append({
                "step": self.step,
                "summary": "%s -> refused by policy" % action.action,
                "verdict": "denied", "detail": decision.reason,
            })
            return None

        if decision.decision == "confirm":
            granted = await self._request_confirmation(action, decision, obs)
            if not granted:
                raise TaskCancelled()

        await bus.emit("POLICY_APPROVED", {
            "action_id": action.action_id, "action": action.action,
            "decision": decision.model_dump(),
        }, task_id=self.task_id, step=self.step)

        # --- EXECUTE (with retries) ---
        await self.set_state("EXECUTING")
        executed_at = now_iso()
        result: Dict[str, Any] = {}
        exec_error: Optional[str] = None
        for attempt_n in range(config.ACTION_RETRIES + 1):
            try:
                result = await self.execute(action, obs)
                exec_error = None
                break
            except BridgeError as exc:
                exec_error = str(exc)
                await bus.emit("ACTION_FAILED", {
                    "action_id": action.action_id, "action": action.action,
                    "attempt": attempt_n + 1, "error": exec_error,
                }, task_id=self.task_id, step=self.step)
                if attempt_n < config.ACTION_RETRIES:
                    await asyncio.sleep(0.8)

        if exec_error is not None:
            self.history.append({
                "step": self.step,
                "summary": "%s -> could not execute" % action.action,
                "verdict": "failed", "detail": exec_error,
            })
            return await self._recover(obs, exec_error)

        await bus.emit("ACTION_EXECUTED", {
            "action_id": action.action_id, "action": action.action,
            "result": _trim(result),
        }, task_id=self.task_id, step=self.step)

        if action.action == "extract":
            items = result.get("items") or []
            for item in items:
                item["source_url"] = obs.url
            self.extracted.extend(items)

        # --- VERIFY against a FRESH observation ---
        await self.set_state("VERIFYING")
        await asyncio.sleep(0.35)
        want_shot = (
            config.SCREENSHOT_EVERY > 0 and self.step % config.SCREENSHOT_EVERY == 0
        )
        after = await self.observe(screenshot=want_shot)

        stale = verifier.check_freshness(obs, after, action, executed_at)
        if stale is not None:
            await bus.emit("VERIFICATION_FAILED", {
                "action_id": action.action_id, "reason": "stale observation: " + stale,
            }, task_id=self.task_id, step=self.step)
            await asyncio.sleep(0.8)
            after = await self.observe()

        verdict = verifier.verify(action, obs, after, result)

        if verdict.verdict == "uncertain":
            await asyncio.sleep(0.8)
            after = await self.observe()
            verdict = verifier.verify(action, obs, after, result)

        if verdict.verdict == "success":
            self.consecutive_verify_failures = 0
            await bus.emit("ACTION_VERIFIED", {
                "action_id": action.action_id, "action": action.action,
                "verdict": verdict.model_dump(),
            }, task_id=self.task_id, step=self.step)
            self.history.append({
                "step": self.step,
                "summary": "%s (%s)" % (action.action, redact_preview(action)),
                "verdict": "verified",
                "detail": "; ".join(verdict.signals[:3]),
            })
            return after

        self.consecutive_verify_failures += 1
        await bus.emit("VERIFICATION_FAILED", {
            "action_id": action.action_id, "action": action.action,
            "verdict": verdict.model_dump(),
            "consecutive": self.consecutive_verify_failures,
        }, task_id=self.task_id, step=self.step)
        self.history.append({
            "step": self.step,
            "summary": "%s (%s)" % (action.action, redact_preview(action)),
            "verdict": "NOT verified",
            "detail": verdict.reason + " | " + "; ".join(verdict.signals[:3]),
        })

        if self.consecutive_verify_failures >= config.MAX_CONSECUTIVE_VERIFY_FAILURES:
            raise RuntimeError(
                "three consecutive actions failed verification. Last: %s (%s). "
                "Reporting this as blocked rather than continuing blindly."
                % (verdict.reason, "; ".join(verdict.signals[:4]))
            )

        return await self._recover(after, verdict.reason)

    async def _recover(self, obs: Observation, last_error: str) -> Optional[Observation]:
        await self.set_state("RECOVERING", last_error[:120])
        await bus.emit("RECOVERY_STARTED", {"trigger": last_error[:300]},
                       task_id=self.task_id, step=self.step)
        handled = await recovery.attempt(obs, last_error, self.task_id, self.step)
        await bus.emit("RECOVERY_COMPLETED", {
            "handled": handled is not None,
            "handler": (handled or {}).get("handler"),
            "detail": (handled or {}).get("detail", "no deterministic handler applied; re-reasoning"),
        }, task_id=self.task_id, step=self.step)
        try:
            return await self.observe()
        except BridgeError:
            return None

    # -- confirmation gate --------------------------------------------------
    async def _request_confirmation(self, action: ActionProposal, decision,
                                    obs: Observation) -> bool:
        await self.set_state("WAITING_FOR_CONFIRMATION")
        shot = await bridge.screenshot(task_id=self.task_id)
        payload = {
            "action_id": action.action_id,
            "action": action.action,
            "preview": redact_preview(action),
            "text_preview": action.params.text or "",
            "target_name": action.target.name or "",
            "url": obs.url,
            "reason": action.reason,
            "decision": decision.model_dump(),
            "screenshot": shot,
            "timeout_s": config.CONFIRM_TIMEOUT_S,
        }
        self._pending_confirmation = {k: v for k, v in payload.items() if k != "screenshot"}
        await bus.emit("CONFIRMATION_REQUESTED", payload,
                       task_id=self.task_id, step=self.step)

        self._confirm_future = asyncio.get_running_loop().create_future()
        try:
            granted = await asyncio.wait_for(self._confirm_future, config.CONFIRM_TIMEOUT_S)
        except asyncio.TimeoutError:
            granted = False
            await bus.emit("CONFIRMATION_DENIED", {
                "action_id": action.action_id,
                "reason": "nobody answered within %.0fs" % config.CONFIRM_TIMEOUT_S,
            }, task_id=self.task_id, step=self.step)
        finally:
            self._confirm_future = None
            self._pending_confirmation = None

        if granted:
            await bus.emit("CONFIRMATION_GRANTED", {
                "action_id": action.action_id, "action": action.action,
                "preview": redact_preview(action),
            }, task_id=self.task_id, step=self.step)
        elif self.state == "WAITING_FOR_CONFIRMATION":
            await bus.emit("CONFIRMATION_DENIED", {
                "action_id": action.action_id, "reason": "a human declined this action",
            }, task_id=self.task_id, step=self.step)
        return granted

    # -- the run ------------------------------------------------------------
    async def run(self) -> None:
        await bus.emit("TASK_CREATED", {"command": self.command, "task_id": self.task_id},
                       task_id=self.task_id, step=0)
        try:
            # --- PLANNING ---
            await self.set_state("PLANNING")
            try:
                seed = await bridge.observe(task_id=self.task_id)
                current_url = seed.url
            except BridgeError:
                current_url = ""
            self.plan = await planner.make_plan(self.command, self.task_id, current_url)
            await bus.emit("PLAN_GENERATED", self.plan.model_dump(),
                           task_id=self.task_id, step=0)

            if self.plan.start_url:
                await bus.emit("ACTION_EXECUTING", {
                    "action": "navigate", "preview": "navigate to " + self.plan.start_url,
                    "note": "opening the plan's starting page",
                }, task_id=self.task_id, step=0)
                res = await bridge.request("navigate", {"url": self.plan.start_url},
                                           task_id=self.task_id)
                await bus.emit("ACTION_EXECUTED", {"action": "navigate", "result": res},
                               task_id=self.task_id, step=0)

            # --- MAIN LOOP ---
            await self.set_state("OBSERVING")
            obs = await self.observe()

            while True:
                self._guard()
                if self.step >= config.MAX_STEPS:
                    raise RuntimeError("hit the %d step budget without finishing" % config.MAX_STEPS)
                if time.monotonic() - self.started > config.WALL_CLOCK_S:
                    raise RuntimeError("hit the %.0fs wall-clock budget without finishing"
                                       % config.WALL_CLOCK_S)

                if obs.page_state.login_wall is not None:
                    obs = await self.wait_for_login(obs)

                await self.set_state("OBSERVING")
                nxt = await self.step_once(obs)
                if nxt is not None:
                    obs = nxt
                else:
                    await asyncio.sleep(0.4)
                    obs = await self.observe()

        except _Finished:
            await self.set_state("COMPLETED")
            await bus.emit("TASK_COMPLETED", {
                "summary": self.summary,
                "steps": self.step,
                "elapsed_s": round(time.monotonic() - self.started, 1),
                "data_gathered": self.extracted[:40],
            }, task_id=self.task_id, step=self.step)

        except TaskCancelled:
            await self.set_state("CANCELLED")
            await bus.emit("TASK_CANCELLED", {
                "steps": self.step,
                "reason": "cancelled by the user (or an approval was declined)",
            }, task_id=self.task_id, step=self.step)

        except Exception as exc:  # noqa: BLE001 - a real failure must be reported as one
            self.error = str(exc)
            await self.set_state("FAILED")
            await bus.emit("TASK_FAILED", {
                "error": self.error,
                "steps": self.step,
                "elapsed_s": round(time.monotonic() - self.started, 1),
                "history_tail": self.history[-5:],
                "data_gathered": self.extracted[:40],
            }, task_id=self.task_id, step=self.step)


class _Finished(Exception):
    pass


def _trim(value: Any, limit: int = 1400) -> Any:
    """Keep event payloads readable in the cockpit and the audit file."""
    if isinstance(value, dict):
        return {k: _trim(v, limit) for k, v in list(value.items())[:30]}
    if isinstance(value, list):
        return [_trim(v, limit) for v in value[:25]]
    if isinstance(value, str) and len(value) > limit:
        return value[:limit] + "...(%d more chars)" % (len(value) - limit)
    return value


# ---------------------------------------------------------------------------
# Registry -- several tasks can exist; one runs at a time against one browser.
# ---------------------------------------------------------------------------
class Registry:
    def __init__(self) -> None:
        self.tasks: Dict[str, Task] = {}
        self._running: Optional[asyncio.Task] = None
        self.active_task_id: Optional[str] = None

    def create(self, command: str) -> Task:
        task = Task(command)
        self.tasks[task.task_id] = task
        return task

    async def start(self, command: str) -> Task:
        if self._running is not None and not self._running.done():
            raise RuntimeError(
                "a task is already running (%s). Cancel it before starting another."
                % self.active_task_id
            )
        task = self.create(command)
        self.active_task_id = task.task_id
        self._running = asyncio.create_task(task.run())
        return task

    def get(self, task_id: Optional[str]) -> Optional[Task]:
        if task_id:
            return self.tasks.get(task_id)
        return self.tasks.get(self.active_task_id) if self.active_task_id else None

    def list(self) -> List[Dict[str, Any]]:
        return [t.snapshot() for t in self.tasks.values()]


registry = Registry()
