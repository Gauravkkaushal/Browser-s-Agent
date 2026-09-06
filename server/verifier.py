"""Verification.

After every meaningful action the loop takes a FRESH observation and asks: did
the intended change actually happen? The model's own `expected` block is checked
first, then generic state-change signals.

Freshness (gate G5): an observation older than OBSERVATION_MAX_AGE_S, or one
taken on a different URL than the action ran on, is rejected outright -- except
right after a navigation, where the URL is supposed to change.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from .config import OBSERVATION_MAX_AGE_S
from .schemas import ActionProposal, Observation, Verdict

NAVIGATIONAL = {"navigate", "open_tab", "switch_tab", "back", "forward", "close_tab"}


def _parse_ts(value: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def check_freshness(before: Observation, after: Observation,
                    action: ActionProposal, executed_at: str) -> Optional[str]:
    """Return a rejection reason, or None if the observation may be trusted."""
    ts = _parse_ts(after.observed_at)
    exec_ts = _parse_ts(executed_at)
    if ts is not None and exec_ts is not None:
        age = (ts - exec_ts).total_seconds()
        if age < -1.0:
            return "observation predates the action (age %.1fs)" % age
        if age > OBSERVATION_MAX_AGE_S + 30:
            return "observation is %.1fs older than the freshness budget" % age
    if action.action not in NAVIGATIONAL and action.action != "click":
        # A non-navigational action should not have moved us to a different page.
        if before.url and after.url and before.url != after.url:
            return "page changed underneath a non-navigational action (%s -> %s)" % (
                before.url[:80], after.url[:80],
            )
    return None


def _text_of(obs: Observation) -> str:
    parts = [obs.title, obs.page_text]
    for el in obs.interactive_elements:
        if el.name:
            parts.append(el.name)
        if el.text:
            parts.append(el.text)
        if el.value:
            parts.append(el.value)
    return " \n ".join(parts).lower()


def verify(action: ActionProposal, before: Observation, after: Observation,
           exec_result: Dict[str, Any]) -> Verdict:
    # `signals` is evidence that something really changed. `notes` explains the
    # reasoning and must never, by itself, make a verdict look positive.
    signals: List[str] = []
    notes: List[str] = []
    expected = action.params.expected

    # ---- 0. The field's own readback outranks any prediction ---------------
    #
    # For typing there is a direct, physical answer: read the field back and see
    # whether the text is in it. That beats anything the model predicted -- a
    # prediction like "the page will contain this text" can be satisfied by the
    # text appearing somewhere else entirely, and then the agent goes on to
    # press Send on an empty box.
    result = exec_result or {}
    if action.action == "type" and "verified" in result:
        if result.get("verified"):
            return Verdict(
                verdict="success",
                signals=["field readback contains the typed text (%s)" % result.get("strategy")],
                reason="the field itself confirms the text landed",
            )
        return Verdict(
            verdict="failed",
            signals=["field readback does NOT contain the typed text (%s)" % result.get("strategy"),
                     "readback was: %s" % str(result.get("readback", ""))[:120]],
            reason="the text did not land in the field. Do not act on it as though "
                   "it had -- focus the field and type again, or find the right field",
        )

    # ---- 1. The model's own prediction ------------------------------------
    #
    # A prediction only counts as evidence if it was NOT already true before the
    # action. "The chat list will contain the group name" is satisfied by a
    # sidebar that showed the name all along, so it would mark every click a
    # success no matter what happened -- which is how an agent ends up clicking
    # the same row twenty times and calling each one verified.
    if expected is not None:
        checks: List[bool] = []
        before_text = _text_of(before)
        after_text = _text_of(after)
        vacuous: List[str] = []

        if expected.url_contains:
            hit = expected.url_contains.lower() in after.url.lower()
            if expected.url_contains.lower() in before.url.lower():
                vacuous.append("url_contains(%s) was already true" % expected.url_contains[:30])
            else:
                checks.append(hit)
            notes.append("url_contains(%s)=%s" % (expected.url_contains[:40], hit))

        if expected.text_contains:
            needle = expected.text_contains.lower()
            hit = needle in after_text
            if needle in before_text:
                vacuous.append("text_contains(%s) was already true before the action"
                               % expected.text_contains[:30])
            else:
                checks.append(hit)
            notes.append("text_contains(%s)=%s" % (expected.text_contains[:40], hit))

        if expected.element_appears:
            needle = expected.element_appears.lower()

            def _present(o: Observation) -> bool:
                return any(needle in (el.name or "").lower()
                           or needle in (el.text or "").lower()
                           or needle == el.eid.lower()
                           for el in o.interactive_elements)

            hit = _present(after)
            if _present(before):
                vacuous.append("element_appears(%s) was already present"
                               % expected.element_appears[:30])
            else:
                checks.append(hit)
            notes.append("element_appears(%s)=%s" % (expected.element_appears[:40], hit))

        if expected.element_gone:
            needle = expected.element_gone.lower()
            still = any(needle in (el.name or "").lower() or needle in (el.text or "").lower()
                        for el in after.interactive_elements)
            checks.append(not still)
            notes.append("element_gone(%s)=%s" % (expected.element_gone[:40], not still))

        if vacuous and not checks:
            # Every prediction was already satisfied before we acted, so none of
            # them says anything about whether the action worked. Fall through to
            # the generic signals rather than award a free pass.
            notes.append("prediction proved nothing: " + "; ".join(vacuous[:2]))
            expected = None

        if checks:
            signals.extend(notes)
            if all(checks):
                return Verdict(verdict="success", signals=signals,
                               reason="every predicted change is present in the new observation")
            if after.page_state.loading:
                # The page has not finished arriving; there is nothing to judge yet.
                signals.append("page still loading")
                return Verdict(verdict="uncertain", signals=signals + notes,
                               reason="the page is still loading, so the predicted "
                                      "change may simply not have rendered yet")
            if not any(checks):
                return Verdict(verdict="failed", signals=signals,
                               reason="none of the predicted changes happened")
            return Verdict(verdict="uncertain", signals=signals,
                           reason="only some predicted changes are present")

    # ---- 2. Generic state-change signals ----------------------------------
    if before.url != after.url:
        signals.append("url changed: %s -> %s" % (before.url[:60], after.url[:60]))
    if before.scroll.get("y") != after.scroll.get("y"):
        signals.append("scroll moved %s -> %s" % (before.scroll.get("y"), after.scroll.get("y")))
    before_focus = (before.focused_element or {}).get("eid")
    after_focus = (after.focused_element or {}).get("eid")
    if before_focus != after_focus:
        signals.append("focus moved")
    delta = len(after.interactive_elements) - len(before.interactive_elements)
    if abs(delta) >= 3:
        signals.append("interactive element count changed by %+d" % delta)
    if before.page_state.overlay_present != after.page_state.overlay_present:
        signals.append("overlay %s" % ("appeared" if after.page_state.overlay_present else "dismissed"))
    if after.page_state.loading:
        signals.append("page still loading")

    # The executor's own self-report is direct evidence for typing.
    result = exec_result or {}
    if action.action == "type":
        if result.get("verified"):
            signals.append("field readback contains the typed text (%s)" % result.get("strategy"))
            return Verdict(verdict="success", signals=signals,
                           reason="the field itself confirms the text landed")
        signals.append("field readback did NOT contain the typed text")
        return Verdict(verdict="failed", signals=signals,
                       reason="typing did not take effect in the field")

    if action.action == "extract":
        items = result.get("items") or []
        if items:
            return Verdict(verdict="success", signals=["extracted %d items" % len(items)],
                           reason="the page yielded structured items")
        return Verdict(verdict="failed", signals=[result.get("reason", "no items")],
                       reason="nothing structured could be read from this page")

    if action.action in ("wait", "screenshot", "scroll", "hover", "focus"):
        return Verdict(verdict="success", signals=(signals + notes) or ["no state change required"],
                       reason="%s does not require a page change" % action.action)

    if action.action in NAVIGATIONAL:
        if before.url != after.url or action.action in ("open_tab", "switch_tab", "close_tab"):
            return Verdict(verdict="success", signals=signals + notes, reason="navigation took effect")
        return Verdict(verdict="failed", signals=(signals + notes) or ["url unchanged"],
                       reason="the URL did not change after a navigation")

    if signals:
        return Verdict(verdict="success", signals=signals + notes,
                       reason="the page changed in a way consistent with the action")

    return Verdict(verdict="uncertain", signals=["no observable change"] + notes,
                   reason="nothing measurable changed; the action had no visible "
                          "effect, so trying it again will not help")
