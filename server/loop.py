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
import re
import time
import uuid
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from . import config, documents, planner, reasoner, recovery, verifier
from .browser_bridge import BridgeError, bridge
from .events import bus
from . import llm
from .llm import ModelError
from .reasoner import MalformedAction
from .policy import evaluate, redact_preview
from .redaction import redact_text
from .sanitizer import sanitize_observation
from .quoter import compose_message
from .capability_gate import check as check_capability
from .vault import mask, vault
from .schemas import (
    BROWSER_VERBS, CONTROL_VERBS, ActionProposal, Observation, Plan,
    TERMINAL_VERBS, now_iso,
)


# Failures that will never succeed on a retry: a malformed action, or a page
# that is closed to extensions no matter how often we ask.
PERMANENT_FAILURE = re.compile(
    r"requires (target|params)\.|not a page verb|unknown bridge op|"
    r"chrome:// and store pages|cannot operate on this page|"
    r"refusing to close|is not an? <select>|unsupported page verb",
    re.I,
)


# A plan step that is a stand-in for work nobody could specify yet. Its presence
# means the plan was written before the real request had been read.
PLACEHOLDER_STEP = re.compile(
    r"complete (the |what)?.{0,20}(task|request|asked|instruction)"
    r"|(the )?(requested|required) task"
    r"|perform (the )?(actions?|task|work)"
    r"|(do|carry out|fulfil|fulfill) (what|whatever|the thing)"
    r"|as (requested|asked|instructed)"
    r"|execute the task",
    re.I,
)


# An honest "there was nothing to act on". Distinguishing this from giving up
# matters: the first is a real answer, the second is a dodge.
NOTHING_TO_DO = re.compile(
    r"no (specific |actionable |explicit |clear |further |new )*"
    r"(command|request|task|instruction|action|message)"
    r"|nothing to (do|act on)"
    r"|did not (ask|request|give)"
    r"|has not (asked|requested|sent)"
    r"|no one (asked|requested)",
    re.I,
)


# Ways the browser says "you may not read this page". None of them is a fault
# that retrying fixes; all of them leave a screenshot as the only way in.
_UNREADABLE_PAGE = re.compile(
    r"cannot operate on this page|chrome:// and store pages|"
    r"no ordinary web page is open|extensions cannot read",
    re.I,
)


def _site_of(url: str) -> str:
    """Just the host, for noticing that the agent has moved somewhere new."""
    try:
        return (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""


class TaskCancelled(Exception):
    pass


class Task:
    """One running task. Owns its own FSM state and audit trail."""

    def __init__(self, command: str, pre_approved: bool = False,
                 privacy_mode: str = "balanced") -> None:
        self.task_id = "task_" + uuid.uuid4().hex[:10]
        self.command = command
        # The operator may pre-authorise this one task's high-risk actions
        # before it starts. The policy layer still classifies every action and
        # still logs the decision -- what changes is only who answers, and the
        # answer is recorded as coming from a standing authorisation rather
        # than being invented by the agent.
        self.pre_approved = pre_approved
        # How hard the page-side redaction should work before anything leaves
        # the machine. Words from the operator's own command are never hidden --
        # withholding them protects nothing they have not already said, and it
        # would make the task impossible.
        self.privacy_mode = privacy_mode
        self.keep_terms = [w.strip(".,!?'\"") for w in command.split() if len(w) > 2][:24]
        self.state = "PLANNING"
        self.step = 0
        self.started = time.monotonic()
        self.plan: Optional[Plan] = None
        self.history: List[Dict[str, Any]] = []
        self.extracted: List[Dict[str, Any]] = []
        self.consecutive_verify_failures = 0
        self._unearned_finishes = 0
        self._recent_signatures: List[str] = []
        self._last_failed_signature: str = ""
        self._dead_targets: Dict[str, str] = {}
        self._last_shot_site: str = ""
        # What was last typed successfully. The clearest proof a submit
        # worked is that this text has left the field it was typed into.
        self._last_typed: str = ""
        # The most recent masked snapshot, kept so a UI that was closed and
        # reopened can show what was redacted rather than an empty card.
        self.last_screenshot: Optional[str] = None
        self._replans = 0
        self.discovered: str = ""
        self.notes: List[str] = []
        self.cancelled = False
        self.summary: str = ""
        self.error: str = ""
        self.quoted_message: Optional[str] = None
        # PDF text by url. A paper does not change between steps.
        self._document_cache: Dict[str, str] = {}
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
            "last_screenshot": self.last_screenshot,
            "privacy_mode": self.privacy_mode,
        }

    # -- confirmation -------------------------------------------------------
    def confirm(self, granted: bool, scope: str = "once") -> bool:
        """Answer the pending confirmation.

        scope="task" means the operator answered for the whole task, not just
        this one action: they are not asked again for anything of the same
        class while it runs. Authentication codes are excluded from that at the
        policy layer and stay live no matter what is set here.
        """
        if granted and scope == "task":
            self.pre_approved = True
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
        try:
            obs = await bridge.observe(task_id=self.task_id, screenshot=screenshot,
                                       privacy_mode=self.privacy_mode,
                                       keep_terms=self.keep_terms)
        except BridgeError as exc:
            # The page refused a content script outright. That is the browser's
            # rule, not a fault to retry -- and giving up here is what made
            # "explain this page" answer "no page". Build an observation out of
            # a screenshot instead, and be explicit that it came from sight.
            if not _UNREADABLE_PAGE.search(str(exc)):
                raise
            obs = Observation(url="", title="", page_kind="unreadable",
                              errors=["the DOM is closed to extensions: %s" % exc])
            obs = await self._read_by_sight(obs)
            if not obs.page_text.strip():
                raise
            return obs
        if obs.screenshot:
            self.last_screenshot = obs.screenshot
        obs = await self._read_document_if_needed(obs)
        # Still nothing to read? Then the DOM was never going to give it up --
        # a scanned PDF, or a page the browser closes to extensions. Look at it.
        if not obs.page_text.strip() and not obs.interactive_elements:
            obs = await self._read_by_sight(obs)
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
            "user_tab_note": obs.user_tab_note,
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
                fresh = await bridge.observe(task_id=self.task_id,
                                             privacy_mode=self.privacy_mode,
                                             keep_terms=self.keep_terms)
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

        # A credential is substituted here, at the last possible moment, and
        # travels no further than the browser. The model proposed a slot name;
        # it never saw, and never will see, the value.
        if verb == "fill_credential":
            secret = vault.resolve(action.params.slot or "", obs.url)
            payload = action.model_dump()
            payload["action"] = "type"
            payload["params"]["text"] = secret
            payload["params"]["slot"] = None
            result = await bridge.request("act", {"action": payload}, task_id=self.task_id)
            # Whatever came back may echo the field contents; scrub it.
            if isinstance(result, dict) and result.get("readback"):
                result["readback"] = mask(secret)
            return result

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
            elif verb == "download":
                args = {"url": action.params.url, "tab_id": action.target.tab_id}
            elif verb == "list_downloads":
                args = {"filename_contains": action.params.filename_contains}
            elif verb == "upload_file":
                args = {"tab_id": action.target.tab_id,
                        "element_id": action.target.element_id,
                        "file_path": action.params.file_path}
            return await bridge.request(verb, args, task_id=self.task_id)

        payload = action.model_dump()
        return await bridge.request("act", {"action": payload}, task_id=self.task_id)

    async def step_once(self, obs: Observation) -> Optional[Observation]:
        """observe -> reason -> policy -> execute -> verify. Returns next obs."""
        self.step += 1
        
        # The reasoner gets a SEPARATE, sanitized copy. The original stays intact
        # for grounding, execution and verification -- those have to match the
        # real page, not a marked-up rendering of it.
        reasoner_obs, mask_report = sanitize_observation(obs.model_copy(deep=True))
        # Say out loud, every step, exactly what was hidden before the model saw
        # anything. A privacy claim nobody can watch is a privacy claim nobody
        # should believe.
        await bus.emit("MASKING_APPLIED", mask_report,
                       task_id=self.task_id, step=self.step)

        # If we have a quoted message, make sure the reasoner knows it has it available
        if self.quoted_message:
            reasoner_obs.user_tab_note = (reasoner_obs.user_tab_note or "") + f" [QUOTED_MESSAGE_READY: {self.quoted_message}]"

        # --- REASONING ---
        await self.set_state("REASONING")
        try:
            action = await reasoner.propose(
                self.plan.objective if self.plan else self.command,
                self.plan, reasoner_obs, self.history, self.task_id, self.step, self.extracted,
                discovered=self.discovered, notes=self.notes,
                dead_targets=self._dead_targets,
            )
            # Re-ground against the original observation to remove datamarks from the UI
            from .reasoner import _ground
            action = _ground(action, obs)
        except MalformedAction as exc:
            # An unusable reply costs a step, not the task. This escaping as a
            # fatal error ended a multi-site run at the final hop because one
            # optional field arrived as a string instead of an object.
            await bus.emit("VERIFICATION_FAILED", {
                "reason": str(exc), "counted_as_strike": False,
            }, task_id=self.task_id, step=self.step)
            self.history.append({
                "step": self.step,
                "summary": "the model's reply could not be read as an action",
                "verdict": "rejected",
                "detail": str(exc)[:200],
            })
            return None
        except ModelError as exc:
            raise RuntimeError("the reasoner could not produce a valid action: %s" % exc)

        # --- LOOP BREAKER ---
        # Doing the same thing again and expecting a different page is the most
        # common way an agent wastes a task. Track the shape of each action and
        # refuse the third identical one, telling the reasoner plainly that this
        # route is exhausted.
        # The signature must capture everything that makes this action
        # *different*. Leaving the tab out made every switch_tab look identical,
        # so moving to a second tab was blocked as a repeat of moving to the
        # first -- and the page it is judged against matters too, because the
        # same click on a different page is a different act.
        signature = "%s|%s|%s|%s|tab=%s|on=%s" % (
            action.action,
            action.target.nid or action.target.element_id or "",
            (action.target.name or "")[:40],
            (action.params.text or action.params.url or action.params.key_combo or "")[:40],
            action.target.tab_id if action.target.tab_id is not None else "-",
            obs.url[:80],
        )
        self._recent_signatures.append(signature)
        self._recent_signatures = self._recent_signatures[-12:]
        repeats = self._recent_signatures.count(signature)
        if repeats >= 2:
            # Take the dead element off the table. Telling the model "stop doing
            # that" plainly does not work -- it re-proposes the same click and
            # the task dies on a tripwire of our own making. Removing the
            # element from what it can see forces it to actually look elsewhere,
            # which is what we wanted it to do in the first place.
            for key in (action.target.nid, action.target.element_id):
                if key:
                    self._dead_targets[key] = (action.target.name or "")[:60]
        if repeats >= 3:
            note = (
                "'%s' on %r has now been tried %d times and the page has not moved on. "
                "That route is exhausted -- do something different: look for a "
                "different element, scroll to reveal more of the page, or say what is "
                "blocking you with `fail`."
                % (action.action, (action.target.name or action.target.element_id or "?")[:50], repeats)
            )
            await bus.emit("POLICY_DENIED", {
                "action_id": action.action_id,
                "action": action.action,
                "decision": {
                    "decision": "deny", "risk": "blocked",
                    "rules_fired": ["repeated-ineffective-action"],
                    "reason": note,
                },
            }, task_id=self.task_id, step=self.step)
            self.history.append({
                "step": self.step,
                "summary": "%s (%s) -> BLOCKED as a repeat" % (action.action, redact_preview(action)),
                "verdict": "blocked",
                "detail": note,
            })
            if repeats >= 8:
                raise RuntimeError(
                    "the same action was proposed %d times without changing the page, "
                    "even after it was removed from what the agent can see: %s"
                    % (repeats, note)
                )
            return None

        await bus.emit("ACTION_PROPOSED", {
            "action_id": action.action_id,
            "action": action.action,
            "target": action.target.model_dump(),
            "params": action.params.model_dump(exclude_none=True),
            "reason": action.reason,
            "confidence": action.confidence,
            "preview": redact_preview(action),
        }, task_id=self.task_id, step=self.step)

        # --- NOTE ---
        # Somewhere to put a fact so it survives the next twenty steps. Without
        # this the agent finds the answer, keeps browsing, and by the time it
        # returns to deliver it the detail has fallen out of the history.
        if action.action == "note":
            fact = (action.params.text or action.params.summary
                    or action.params.discovered or "").strip()
            if not fact:
                self.history.append({
                    "step": self.step,
                    "summary": "note -> ignored, nothing was recorded",
                    "verdict": "rejected",
                    "detail": "note needs params.text",
                })
                return None
            
            self.notes.append(fact[:1200])
            await bus.emit("ACTION_EXECUTED", {
                "action_id": action.action_id, "action": "note",
                "result": {"recorded": fact[:300], "notes_held": len(self.notes)},
            }, task_id=self.task_id, step=self.step)
            self.history.append({
                "step": self.step,
                "summary": "note -> recorded a finding",
                "verdict": "verified",
                "detail": fact[:200],
            })
            return obs

        # --- QUOTER ---
        if action.action == "request_quoted_message":
            purpose = action.params.purpose or "Write the outgoing message based on the notes."
            quoted = await compose_message(self.command, self.notes, purpose)
            self.quoted_message = quoted
            
            self.notes.append(f"Prepared quoted message for purpose '{purpose}': {quoted[:200]}")
            await bus.emit("ACTION_EXECUTED", {
                "action_id": action.action_id, "action": "request_quoted_message",
                "result": {"quoted_message": quoted[:300]},
            }, task_id=self.task_id, step=self.step)
            
            self.history.append({
                "step": self.step,
                "summary": "request_quoted_message -> generated outgoing text",
                "verdict": "verified",
                "detail": quoted[:200],
            })
            return obs

        # --- REPLAN ---
        # An open-ended command ("do what he asked me to") cannot be planned
        # properly at the start, because the objective is written somewhere the
        # agent has not read yet. Once it HAS read it, it says so here and gets
        # a real plan for the actual work, instead of improvising against a
        # placeholder.
        if action.action == "replan":
            discovered = (action.params.discovered or action.params.objective
                          or action.params.summary or action.reason or "").strip()
            if not discovered:
                self.history.append({
                    "step": self.step,
                    "summary": "replan -> ignored, nothing was described",
                    "verdict": "rejected",
                    "detail": "replan needs params.discovered saying what was learned",
                })
                return None
            if self._replans >= config.MAX_REPLANS:
                self.history.append({
                    "step": self.step,
                    "summary": "replan -> refused, already replanned %d times" % self._replans,
                    "verdict": "rejected",
                    "detail": "the plan has been rewritten enough; carry it out or "
                              "report what is blocking you",
                })
                return None
            self._replans += 1
            await self.set_state("PLANNING", "rewriting the plan around what was just read")
            done = "\n".join(
                "- %s" % h["summary"] for h in self.history if h.get("verdict") == "verified"
            )
            self.plan = await planner.make_plan(
                self.command, self.task_id, obs.url,
                discovered=discovered, done_so_far=done, step=self.step,
            )
            self.discovered = discovered
            payload = self.plan.model_dump()
            payload["replanned"] = True
            payload["discovered"] = discovered[:600]
            payload["replan_count"] = self._replans
            await bus.emit("PLAN_GENERATED", payload, task_id=self.task_id, step=self.step)
            self.history.append({
                "step": self.step,
                "summary": "replan -> the real task is now known",
                "verdict": "verified",
                "detail": discovered[:200],
            })
            # A fresh plan deserves a clean slate for the repeat detector.
            self._recent_signatures = []
            self._dead_targets = {}
            return obs

        # --- TERMINAL VERBS ---
        if action.action in TERMINAL_VERBS:
            if action.action == "finish":
                # A model cannot declare victory having done nothing. Some models
                # will narrate a task they never performed -- claiming a click and
                # a navigation that the observation flatly contradicts. Success is
                # only credible once at least one action has actually been
                # executed and verified against a real page.
                rejection = self._reject_unearned_finish(action, obs)
                if rejection is not None:
                    self._unearned_finishes += 1
                    await bus.emit("VERIFICATION_FAILED", {
                        "action_id": action.action_id,
                        "action": "finish",
                        "reason": rejection,
                        "claimed_summary": (action.params.summary or "")[:300],
                    }, task_id=self.task_id, step=self.step)
                    self.history.append({
                        "step": self.step,
                        "summary": "finish -> REJECTED, nothing had actually been done",
                        "verdict": "rejected",
                        "detail": rejection,
                    })
                    if self._unearned_finishes >= 2:
                        raise RuntimeError(
                            "the task was declared complete twice and rejected twice. "
                            "Reason: %s Last claim: %s"
                            % (rejection, (action.params.summary or action.reason)[:200])
                        )
                    return None
                self.summary = action.params.summary or action.reason
                raise _Finished()
            self.error = action.params.error or action.reason
            raise RuntimeError(self.error)

        # --- POLICY ---
        await self.set_state("POLICY_CHECK")
        
        # 1. Trust boundary / capability gate
        allowed, block_reason = check_capability(
            action, obs, self.quoted_message,
            command=self.command, notes=self.notes, extracted=self.extracted,
        )
        if not allowed:
            await bus.emit("SECURITY_BLOCKED", {
                "action": action.action,
                "reason": block_reason,
                "preview": (action.params.text or "")[:160],
            }, task_id=self.task_id, step=self.step)
            await bus.emit("POLICY_DENIED", {
                "action_id": action.action_id, "action": action.action,
                "decision": {
                    "decision": "deny", "risk": "blocked",
                    "rules_fired": ["security-capability-gate"],
                    "reason": block_reason,
                }
            }, task_id=self.task_id, step=self.step)
            self.history.append({
                "step": self.step,
                "summary": "%s -> BLOCKED by security capability gate" % action.action,
                "verdict": "denied", "detail": block_reason,
            })
            return None
            
        # 2. Existing policy rules
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
                # Some failures are permanent: a missing required argument, or a
                # page extensions cannot touch. Retrying those just burns time
                # and fills the log with identical errors.
                permanent = PERMANENT_FAILURE.search(exec_error) is not None
                await bus.emit("ACTION_FAILED", {
                    "action_id": action.action_id, "action": action.action,
                    "attempt": attempt_n + 1, "error": exec_error,
                    "retryable": not permanent,
                }, task_id=self.task_id, step=self.step)
                if permanent:
                    break
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

        if action.action == "type" and (result or {}).get("verified"):
            self._last_typed = action.params.text or ""

        if action.action == "extract":
            items = result.get("items") or []
            for item in items:
                item["source_url"] = obs.url
            self.extracted.extend(items)

        # --- VERIFY against a FRESH observation ---
        await self.set_state("VERIFYING")
        await asyncio.sleep(0.15)
        # Capture whenever the agent lands somewhere new, as well as on the
        # regular cadence. Arriving at a new site is exactly the moment the
        # operator wants to see what was blacked out before anything left the
        # machine -- a proof card that only appears every fifth step is not
        # much of a proof.
        want_shot = (
            (config.SCREENSHOT_EVERY > 0 and self.step % config.SCREENSHOT_EVERY == 0)
            or _site_of(obs.url) != self._last_shot_site
        )
        after = await self.observe(screenshot=want_shot)
        if want_shot:
            self._last_shot_site = _site_of(after.url)

        # Be patient with a slow site. Judging a page that is still loading is
        # judging a page that has not happened yet -- and calling that a failure
        # is how an agent gives up on a server that was merely taking its time.
        waited = 0.0
        while after.page_state.loading and waited < config.SLOW_PAGE_PATIENCE_S:
            self._guard()
            if waited == 0.0:
                await bus.emit("STATE_CHANGED", {
                    "state": "VERIFYING",
                    "detail": "the page is still loading; waiting for it to settle",
                }, task_id=self.task_id, step=self.step)
            await asyncio.sleep(1.0)
            waited += 1.0
            after = await self.observe()
        if waited:
            await bus.emit("RECOVERY_COMPLETED", {
                "handled": True, "handler": "wait-for-slow-page",
                "detail": "waited %.0fs for the page to finish loading before judging it"
                          % waited,
            }, task_id=self.task_id, step=self.step)

        stale = verifier.check_freshness(obs, after, action, executed_at)
        if stale is not None:
            await bus.emit("VERIFICATION_FAILED", {
                "action_id": action.action_id, "reason": "stale observation: " + stale,
            }, task_id=self.task_id, step=self.step)
            await asyncio.sleep(0.5)
            after = await self.observe()

        verdict = verifier.verify(action, obs, after, result, self._last_typed)

        if verdict.verdict == "uncertain":
            await asyncio.sleep(0.5)
            after = await self.observe()
            verdict = verifier.verify(action, obs, after, result, self._last_typed)

        if verdict.verdict == "success":
            if action.action in ("click", "keypress", "submit"):
                self._last_typed = ""
            self.consecutive_verify_failures = 0
            # An action that worked is not evidence of going in circles. Forget
            # it, so a later legitimate repeat of the same shape is not refused
            # for something that succeeded.
            self._recent_signatures = [s for s in self._recent_signatures if s != signature]
            self._dead_targets.pop(action.target.nid or "", None)
            self._dead_targets.pop(action.target.element_id or "", None)
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

        # A page that is still working is not a failed action. Re-observe with
        # patience instead of spending one of the three strikes on it.
        if after.page_state.loading or after.dom_summary.get("interactive_count", 1) == 0:
            await bus.emit("VERIFICATION_FAILED", {
                "action_id": action.action_id,
                "action": action.action,
                "reason": "page had not settled yet; re-observing rather than counting "
                          "this as a failure",
                "counted_as_strike": False,
            }, task_id=self.task_id, step=self.step)
            await asyncio.sleep(2.0)
            settled = await self.observe()
            verdict = verifier.verify(action, obs, settled, result, self._last_typed)
            if verdict.verdict == "success":
                self.consecutive_verify_failures = 0
                await bus.emit("ACTION_VERIFIED", {
                    "action_id": action.action_id, "action": action.action,
                    "verdict": verdict.model_dump(),
                    "note": "confirmed once the page finished loading",
                }, task_id=self.task_id, step=self.step)
                self.history.append({
                    "step": self.step,
                    "summary": "%s (%s)" % (action.action, redact_preview(action)),
                    "verdict": "verified",
                    "detail": "; ".join(verdict.signals[:3]),
                })
                return settled
            after = settled

        if signature != self._last_failed_signature:
            # A different approach deserves a fresh count. Repeats are already
            # caught by the loop breaker above.
            self.consecutive_verify_failures = 0
        self._last_failed_signature = signature
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

    def _reject_unearned_finish(self, action: ActionProposal,
                                obs: Observation) -> Optional[str]:
        """Return why this `finish` is not credible, or None if it is.

        The question worth asking is not "did you press something?" but "is the
        answer you are giving me actually supported by what you saw?".

        Plenty of real tasks are answered by reading: *what is in my inbox*,
        *what does this cost*, *what is due this week*. For those, opening the
        page IS the work, and demanding a click before accepting an answer just
        makes the agent flail. What must never pass is an answer with nothing
        behind it -- a claim to have clicked a link and landed somewhere the
        browser demonstrably is not.
        """
        summary = (action.params.summary or "").strip()
        reason = action.reason or ""

        # 0. Reading the instruction is not carrying it out.
        #
        # When the plan still contains a placeholder step -- "complete the task
        # requested", written before anyone knew what the task was -- finishing
        # means the agent has mistaken discovery for delivery. It has to say
        # what the real request is, get a real plan, and then do it.
        if self._replans == 0 and self.plan is not None:
            placeholder = next(
                (s.goal for s in self.plan.steps if PLACEHOLDER_STEP.search(s.goal)),
                None,
            )
            if placeholder:
                # "There was nothing to do" is a legitimate outcome, not a
                # dodge -- provided the agent actually went and looked. If it
                # has done real, verified work and reports finding no request,
                # accept that; forcing a replan would only make it invent one.
                looked = any(h.get("verdict") == "verified" for h in self.history)
                if looked and NOTHING_TO_DO.search(summary):
                    return None
                return (
                    "the plan still contains an unresolved step (%r) that was written "
                    "before the real request was known. You have read the request but "
                    "not carried it out. Call `replan` with what is actually being "
                    "asked, then do it. If there genuinely is no request to act on, "
                    "say so plainly in the summary." % placeholder[:90]
                )

        # 1. A claimed destination the browser is not at, and never was.
        for token in re.findall(r"https?://[^\s\"')]+", summary + " " + reason):
            host = token.split("//", 1)[-1].split("/", 1)[0].lower()
            if host and host not in obs.url.lower() and not any(
                host in (h.get("detail") or "") for h in self.history
            ):
                return ("the summary claims the browser reached %s, but the live "
                        "observation says it is on %s" % (host, obs.url))

        verified = [h for h in self.history if h.get("verdict") == "verified"]
        if verified:
            return None

        # 2. Nothing has been done yet. That is fine *if* the answer is drawn
        # from the page in front of us -- and not fine if it was invented.
        support = _grounding_ratio(summary, obs)
        if support is None:
            return ("finish was proposed at step %d with no action performed and no "
                    "answer given; the browser is on %s" % (self.step, obs.url))
        if support < 0.5:
            return ("finish was proposed with no action performed, and only %.0f%% of "
                    "the specifics in the summary appear anywhere on the observed "
                    "page. Read the page properly before answering."
                    % (support * 100))
        return None

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

    async def _first_observation(self) -> Observation:
        """Get somewhere to stand, opening a page if there is not one.

        A task died on "no ordinary web page is open" while the browser sat
        there perfectly able to open one. Having nowhere to work is not a
        failure -- it is the first thing to fix, and opening a tab is exactly
        what a person would do before saying the job was impossible.

        Only ever a NEW tab: navigating whatever the operator had in front of
        them would take over their window.
        """
        try:
            return await self.observe(screenshot=True)
        except BridgeError as exc:
            if not _UNREADABLE_PAGE.search(str(exc)):
                raise
            landing = self.plan.start_url if self.plan else None
            landing = landing or config.FALLBACK_START_URL
            await bus.emit("ACTION_EXECUTING", {
                "action": "open_tab", "preview": "open " + landing,
                "note": "there was no ordinary web page to work in, so the agent "
                        "opened one rather than giving up",
            }, task_id=self.task_id, step=0)
            try:
                res = await bridge.request("open_tab", {"url": landing},
                                           task_id=self.task_id)
            except BridgeError as open_exc:
                raise RuntimeError(
                    "there was no web page open and one could not be opened "
                    "either: %s" % open_exc
                ) from open_exc
            await bus.emit("ACTION_EXECUTED", {"action": "open_tab", "result": res},
                           task_id=self.task_id, step=0)
            return await self.observe(screenshot=True)

    async def _read_document_if_needed(self, obs: Observation) -> Observation:
        """Put a PDF's words into page_text, so the agent can actually read it.

        Chrome's PDF viewer is a plugin document: no text, no controls. Left
        alone the agent scrolls, waits, switches tabs and gives up -- exactly
        the shape of a failure that has nothing to do with the task. Fetching
        the file is not a workaround; it is the only place the words exist.

        Fetched once per URL: a paper does not change between steps, and paying
        to re-download and re-parse it every step would be its own bug.
        """
        if obs.page_kind != "pdf" or obs.page_text.strip():
            return obs
        if self._document_cache.get(obs.url) is not None:
            obs.page_text = self._document_cache[obs.url]
            return obs
        try:
            raw = await bridge.request("fetch_document", {"url": obs.url},
                                       task_id=self.task_id)
            info = documents.extract_pdf_text(raw.get("data") or "")
        except (BridgeError, documents.DocumentError) as exc:
            # An honest note in the observation beats silence: the reasoner can
            # then say what is wrong instead of hunting for elements forever.
            obs.errors = list(obs.errors) + ["could not read this PDF: %s" % exc]
            self._document_cache[obs.url] = ""
            await bus.emit("DOCUMENT_READ", {
                "url": obs.url, "ok": False, "error": str(exc),
            }, task_id=self.task_id, step=self.step)
            return obs

        obs.page_text = info["text"]
        self._document_cache[obs.url] = info["text"]
        await bus.emit("DOCUMENT_READ", {
            "url": obs.url, "ok": True, "pages": info["pages"],
            "pages_with_text": info["pages_with_text"],
            "chars": len(info["text"]), "bytes": info["bytes"],
        }, task_id=self.task_id, step=self.step)
        return obs

    VISION_SYSTEM = (
        "You are reading a SCREENSHOT of a page that software cannot read any "
        "other way. Transcribe what is actually on the screen: headings, body "
        "text, labels on buttons and fields, and any values shown.\n"
        "Report only what you can see. Never guess at text that is cut off, and "
        "never invent a value. If the image is unreadable, say so.\n"
        'Return JSON: {"text": "<everything legible, in reading order>", '
        '"note": "<anything important about what you could not read>"}'
    )

    async def _read_by_sight(self, obs: Observation) -> Observation:
        """Last resort for a page no content script may touch.

        chrome:// pages, the Web Store and Chrome's PDF viewer are closed to
        extensions by the browser, not by any bug -- so there is no DOM, and
        stopping is the only honest alternative to looking at the pixels.

        Privacy note, stated plainly because it matters: masking works by
        locating sensitive TEXT with the content script, and the very pages
        that need this fallback are the ones that will not run it. When a
        capture could not be masked, that is recorded on the observation and
        surfaced in the UI rather than quietly implied to be redacted.
        """
        try:
            shot = await bridge.request("capture_any", {
                "privacy_mode": self.privacy_mode,
                "keep_terms": self.keep_terms,
            }, task_id=self.task_id)
        except BridgeError as exc:
            obs.errors = list(obs.errors) + ["could not capture this page: %s" % exc]
            return obs

        image = shot.get("screenshot") or ""
        if not image:
            return obs
        self.last_screenshot = image

        try:
            seen = await llm.call_vision(
                "reasoner", self.VISION_SYSTEM,
                "The page is at %s. Transcribe it." % (shot.get("url") or obs.url),
                image, task_id=self.task_id, step=self.step,
            )
        except ModelError as exc:
            obs.errors = list(obs.errors) + ["no model could read the screenshot: %s" % exc]
            return obs

        # The transcription came off an unmaskable page, so redact it HERE
        # before it is stored, reasoned over or written into a message. This
        # does not undo the image already having been sent -- nothing can --
        # but it keeps the values out of everything downstream.
        text, redactions = redact_text(str(seen.get("text") or ""))
        if not text.strip():
            return obs

        obs.page_text = text
        obs.pii_redactions = {**(obs.pii_redactions or {}), **redactions}
        obs.read_by_sight = True
        obs.mask_note = shot.get("mask_note") or ""
        await bus.emit("PAGE_READ_BY_SIGHT", {
            "url": shot.get("url") or obs.url,
            "chars": len(text),
            "masked": bool(shot.get("masked")),
            "mask_note": obs.mask_note,
            "redacted_after_reading": redactions,
            "note": seen.get("note", ""),
        }, task_id=self.task_id, step=self.step)
        return obs

    # -- confirmation gate --------------------------------------------------
    async def _request_confirmation(self, action: ActionProposal, decision,
                                    obs: Observation) -> bool:
        # A standing pre-authorisation covers sending, posting, paying and
        # uploading. It never covers entering an authentication code.
        needs_live_human = "requires-live-human" in (decision.rules_fired or [])
        if self.pre_approved and not needs_live_human:
            # Still classified HIGH, still logged -- answered by the standing
            # authorisation the operator gave when starting this task.
            await bus.emit("CONFIRMATION_GRANTED", {
                "action_id": action.action_id,
                "action": action.action,
                "preview": redact_preview(action),
                "granted_by": "operator pre-authorisation for this task",
                "decision": decision.model_dump(),
            }, task_id=self.task_id, step=self.step)
            return True

        await self.set_state("WAITING_FOR_CONFIRMATION")
        shot = await bridge.screenshot(task_id=self.task_id)
        if needs_live_human and self.pre_approved:
            await bus.emit("STATE_CHANGED", {
                "state": "WAITING_FOR_CONFIRMATION",
                "detail": "pre-approval does not cover authentication codes; "
                          "this one needs you",
            }, task_id=self.task_id, step=self.step)
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
            "requires_live_human": needs_live_human,
            "timeout_s": config.CONFIRM_TIMEOUT_S,
        }
        self._pending_confirmation = {k: v for k, v in payload.items() if k != "screenshot"}
        await bus.emit("CONFIRMATION_REQUESTED", payload,
                       task_id=self.task_id, step=self.step)

        self._confirm_future = asyncio.get_running_loop().create_future()
        try:
            granted = await asyncio.wait_for(self._confirm_future, config.CONFIRM_TIMEOUT_S)
        except asyncio.TimeoutError:
            # Nobody answering is NOT the same as somebody saying no, and the
            # difference matters: this is the path where a message you asked to
            # be sent quietly never gets sent. Name it for what it is.
            granted = False
            self.error = ("%s was never carried out: the approval sat unanswered for "
                          "%.0fs. Nothing was sent. Tick 'don't ask again' if you do "
                          "not want to be asked each time."
                          % (redact_preview(action), config.CONFIRM_TIMEOUT_S))
            await bus.emit("CONFIRMATION_DENIED", {
                "action_id": action.action_id,
                "timed_out": True,
                "reason": self.error,
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

            # Start from where the operator is actually looking, not from
            # wherever the previous task happened to finish. Inheriting the last
            # task's tab is how "summarise this page" ends up answering about
            # something else entirely.
            try:
                start = await bridge.request("new_task", {}, task_id=self.task_id)
                await bus.emit("STATE_CHANGED", {
                    "state": "PLANNING",
                    "detail": start.get("note", ""),
                    "starting_url": start.get("starting_url"),
                }, task_id=self.task_id, step=0)
            except BridgeError:
                pass

            try:
                seed = await bridge.observe(task_id=self.task_id)
                current_url = seed.url
            except BridgeError:
                current_url = ""
            self.plan = await planner.make_plan(self.command, self.task_id, current_url)

            # "hello" is not a browser task. Answer it and stop -- before a plan
            # is announced, before a tab is opened, before anything is observed.
            # Narrating a plan to greet someone and then failing because no web
            # page happened to be open is a worse answer than saying nothing.
            if self.plan.reply and not self.plan.steps:
                self.summary = self.plan.reply
                raise _Finished()

            await bus.emit("PLAN_GENERATED", self.plan.model_dump(),
                           task_id=self.task_id, step=0)

            if self.plan.start_url:
                # Open a NEW tab rather than navigating whatever the user had in
                # front of them -- that tab may be the cockpit itself. A tab the
                # agent opened is also the only kind it is allowed to close.
                await bus.emit("ACTION_EXECUTING", {
                    "action": "open_tab", "preview": "open " + self.plan.start_url,
                    "note": "the agent works in its own tab so it never takes over yours",
                }, task_id=self.task_id, step=0)
                res = await bridge.request("open_tab", {"url": self.plan.start_url},
                                           task_id=self.task_id)
                await bus.emit("ACTION_EXECUTED", {"action": "open_tab", "result": res},
                               task_id=self.task_id, step=0)

            # --- MAIN LOOP ---
            await self.set_state("OBSERVING")
            # Capture on the very first look. This is the moment the operator
            # most wants to see what was blacked out -- and for a task answered
            # by reading alone, which never executes an action, it is the only
            # chance to take one at all.
            obs = await self._first_observation()
            self._last_shot_site = _site_of(obs.url)

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
                    await asyncio.sleep(0.2)
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
                # If an approval timed out, say so precisely. "Cancelled" on its
                # own reads as "you stopped it" and hides the one outcome the
                # operator most needs to know: the message never went.
                "reason": self.error or "cancelled by the user (or an approval was declined)",
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


# Words too common to prove anything about where an answer came from.
_STOPWORDS = frozenset("""
the a an and or but of to in on at for with from by is are was were be been this
that these those it its as not no you your i me my we our they them he she his
her there here what which who whom when where why how all any some each other
into over under about after before more most many much few less least very just
only also than then so if because while during between both same own such can
will would should could may might must shall do does did done have has had page
inbox email emails message messages user users site website open click read
following recent needs need subject sender from summary successfully
""".split())


def _distinctive_terms(text: str) -> List[str]:
    """The parts of an answer that would be hard to invent by accident."""
    terms: List[str] = []
    # Quoted spans, numbers, and capitalised words carry the specifics.
    terms += re.findall(r'"([^"]{2,40})"', text)
    terms += re.findall(r"\b\d[\d,./:-]{2,}\b", text)
    terms += re.findall(r"\b[A-Z][A-Za-z0-9&._-]{2,}\b", text)
    terms += [w for w in re.findall(r"\b[a-z][a-z0-9._-]{5,}\b", text.lower())
              if w not in _STOPWORDS]
    seen = set()
    out = []
    for t in terms:
        key = t.strip().lower()
        if len(key) < 3 or key in _STOPWORDS or key in seen:
            continue
        seen.add(key)
        out.append(key)
    return out


def _grounding_ratio(summary: str, obs: Observation) -> Optional[float]:
    """How much of the answer can be found in what was actually observed.

    None means the summary said nothing checkable at all.
    """
    terms = _distinctive_terms(summary)
    if len(terms) < 3:
        return None
    haystack = " ".join([
        obs.page_text or "",
        obs.title or "",
        " ".join((el.name or "") + " " + (el.text or "") + " " + (el.value or "")
                 for el in obs.interactive_elements),
    ]).lower()
    if not haystack.strip():
        return 0.0
    hits = sum(1 for t in terms if t in haystack)
    return hits / len(terms)


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

    def create(self, command: str, pre_approved: bool = False,
               privacy_mode: str = "balanced") -> Task:
        task = Task(command, pre_approved=pre_approved, privacy_mode=privacy_mode)
        self.tasks[task.task_id] = task
        return task

    async def start(self, command: str, pre_approved: bool = False,
                    privacy_mode: str = "balanced") -> Task:
        if self._running is not None and not self._running.done():
            raise RuntimeError(
                "a task is already running (%s). Cancel it before starting another."
                % self.active_task_id
            )
        task = self.create(command, pre_approved=pre_approved, privacy_mode=privacy_mode)
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
