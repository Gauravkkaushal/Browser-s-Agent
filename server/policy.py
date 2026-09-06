"""Deterministic policy gateway.

Pure Python, no model involvement. Every proposed action passes through here
before the executor sees it. The reasoner cannot argue its way past this layer,
cannot widen the verb whitelist, and cannot mark its own action low-risk.

Three outcomes:
    allow   -- run it now
    confirm -- hold until a human approves it in the cockpit
    deny    -- refuse outright
"""
from __future__ import annotations

import re
from typing import List, Optional
from urllib.parse import urlparse

from .schemas import ALLOWED_ACTIONS, ActionProposal, Observation, PolicyDecision

# --- Verbs that are always safe to run unattended ---------------------------
LOW_RISK_VERBS = {
    "navigate", "open_tab", "switch_tab", "back", "forward", "scroll", "hover",
    "focus", "wait", "extract", "screenshot", "keypress", "select",
}

# --- Consequential wording on the control being clicked ---------------------
HIGH_RISK_NAME = re.compile(
    r"pay|payment|checkout|buy now|place order|purchase|order now|\bsend\b|delete|"
    r"remove|confirm|transfer|\bpost\b|submit order|subscribe|book now",
    re.I,
)

# --- Fields whose contents must never be typed by the agent unattended ------
HIGH_RISK_FIELD = re.compile(
    r"password|\botp\b|cvv|cvc|card number|cardnumber|aadhaar|upi pin|"
    r"security code|passcode",
    re.I,
)

# --- URLs where any action at all is consequential --------------------------
HIGH_RISK_URL = re.compile(r"checkout|/pay|payment|billing|bank|upi|order/place|purchase", re.I)

# --- Roles that make a click plainly navigational ---------------------------
SAFE_CLICK_ROLES = {"link", "tab"}


def _element_name(action: ActionProposal, observation: Optional[Observation]) -> str:
    if observation is None or not action.target.element_id:
        return action.target.name or ""
    el = observation.element(action.target.element_id)
    if el is None:
        return action.target.name or ""
    return (el.name or el.text or "").strip()


def evaluate(action: ActionProposal, observation: Optional[Observation]) -> PolicyDecision:
    rules: List[str] = []
    verb = action.action

    # ---- DENY: anything outside the whitelist ------------------------------
    if verb not in ALLOWED_ACTIONS:
        return PolicyDecision(
            decision="deny", risk="blocked", rules_fired=["verb-not-whitelisted"],
            reason="'%s' is not an allowed verb" % verb,
        )

    # ---- Terminal verbs report the outcome; they touch nothing -------------
    if verb in ("finish", "fail"):
        return PolicyDecision(
            decision="allow", risk="low", rules_fired=["terminal-verb"],
            reason="reports the task outcome without touching the page",
        )

    url = observation.url if observation else ""
    name = _element_name(action, observation)

    # ---- HIGH: consequential URL ------------------------------------------
    if url and HIGH_RISK_URL.search(url) and verb in ("click", "type", "submit", "keypress"):
        rules.append("high-risk-url")

    # ---- HIGH: submit is always consequential ------------------------------
    if verb == "submit":
        rules.append("submit-verb")

    # ---- HIGH: consequential control name ---------------------------------
    if verb == "click" and name and HIGH_RISK_NAME.search(name):
        rules.append("high-risk-control-name:" + name[:40])

    # ---- HIGH: typing into a protected field ------------------------------
    if verb == "type":
        el = observation.element(action.target.element_id) if (observation and action.target.element_id) else None
        if el is not None and el.is_protected:
            rules.append("protected-field")
        if el is not None and el.input_type.lower() == "password":
            rules.append("password-field")
        haystack = " ".join(filter(None, [name, el.name if el else "", el.input_type if el else ""]))
        if HIGH_RISK_FIELD.search(haystack):
            rules.append("high-risk-field-name")

    # ---- HIGH: Enter inside a consequential context ------------------------
    if verb == "keypress" and (action.params.key_combo or "").strip().lower() == "enter":
        if url and HIGH_RISK_URL.search(url):
            rules.append("enter-on-high-risk-url")

    if rules:
        return PolicyDecision(
            decision="confirm", risk="high", rules_fired=rules,
            reason="needs a human decision: " + "; ".join(rules),
        )

    # ---- LOW: closing a tab, but only one the agent opened ----------------
    if verb == "close_tab":
        tab_id = action.target.tab_id
        owned = False
        if observation is not None and tab_id is not None:
            owned = any(t.tab_id == tab_id and t.agent_owned for t in observation.tabs)
        if not owned:
            return PolicyDecision(
                decision="deny", risk="blocked", rules_fired=["close-foreign-tab"],
                reason="will not close tab %s: the agent did not open it" % tab_id,
            )
        return PolicyDecision(
            decision="allow", risk="low", rules_fired=["close-agent-owned-tab"],
            reason="closing a tab the agent opened",
        )

    # ---- LOW: whitelisted low-risk verbs ----------------------------------
    if verb in LOW_RISK_VERBS:
        return PolicyDecision(
            decision="allow", risk="low", rules_fired=["low-risk-verb:" + verb],
            reason="'%s' does not commit anything" % verb,
        )

    # ---- LOW: plain navigational clicks -----------------------------------
    if verb == "click":
        el = observation.element(action.target.element_id) if (observation and action.target.element_id) else None
        if el is not None:
            if el.role in SAFE_CLICK_ROLES and el.href:
                return PolicyDecision(
                    decision="allow", risk="low",
                    rules_fired=["navigational-click:" + el.role],
                    reason="clicking a plain link",
                )
            if el.role in ("button", "listitem", "menuitem", "option", "row", "gridcell",
                           "checkbox", "radio", "switch", "treeitem", "generic", "div", "span"):
                return PolicyDecision(
                    decision="allow", risk="low",
                    rules_fired=["ordinary-click:" + el.role],
                    reason="clicking a control with no consequential wording",
                )
        return PolicyDecision(
            decision="allow", risk="low", rules_fired=["ordinary-click"],
            reason="clicking a control with no consequential wording",
        )

    # ---- LOW: ordinary typing ---------------------------------------------
    if verb == "type":
        return PolicyDecision(
            decision="allow", risk="low", rules_fired=["ordinary-typing"],
            reason="typing into a field that is not protected",
        )

    return PolicyDecision(
        decision="deny", risk="blocked", rules_fired=["unclassified-verb"],
        reason="no policy class matched '%s'" % verb,
    )


def redact_preview(action: ActionProposal) -> str:
    """Human-readable one-liner for the confirmation modal."""
    verb = action.action
    if verb == "type":
        text = action.params.text or ""
        return 'type "%s"' % (text[:120] + ("..." if len(text) > 120 else ""))
    if verb == "navigate":
        return "navigate to " + (action.params.url or "")
    if verb == "click":
        return "click " + (action.target.name or action.target.element_id or "element")
    if verb == "keypress":
        return "press " + (action.params.key_combo or "")
    return verb
