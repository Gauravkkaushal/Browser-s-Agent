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
from .vault import VaultError, vault

# --- Verbs that are always safe to run unattended ---------------------------
LOW_RISK_VERBS = {
    "navigate", "open_tab", "switch_tab", "back", "forward", "scroll", "hover",
    "focus", "wait", "extract", "screenshot", "keypress", "select",
    "download", "list_downloads",
}

# --- Consequential wording on the control being clicked ---------------------
HIGH_RISK_NAME = re.compile(
    r"pay|payment|checkout|buy now|place order|purchase|order now|\bsend\b|delete|"
    r"remove|confirm|transfer|\bpost\b|submit order|subscribe|book now",
    re.I,
)

# --- Fields whose contents must never be typed by the agent unattended ------
HIGH_RISK_FIELD = re.compile(
    r"password|\botp\b|o\.t\.p|cvv|cvc|card number|cardnumber|aadhaar|upi pin|"
    r"security code|passcode|one[- ]?time|verification code|auth(entication)? code|"
    r"\b2fa\b|mfa",
    re.I,
)

# --- URLs where any action at all is consequential --------------------------
HIGH_RISK_URL = re.compile(r"checkout|/pay|payment|billing|bank|upi|order/place|purchase", re.I)

# --- Rules a standing pre-authorisation can never cover ---------------------
# Completing a second factor is precisely the step that is meant to require a
# person. Everything else in a task may be approved once, up front.
ALWAYS_LIVE_RULES = {"protected-field", "password-field", "high-risk-field-name"}


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

    # ---- Control verbs change the agent's own state, not the page ---------
    if verb == "note":
        return PolicyDecision(
            decision="allow", risk="low", rules_fired=["control-verb:note"],
            reason="records a fact the agent gathered; touches nothing",
        )

    if verb == "replan":
        return PolicyDecision(
            decision="allow", risk="low", rules_fired=["control-verb:replan"],
            reason="rewrites the plan around what was just read; touches nothing",
        )

    # ---- Terminal verbs report the outcome; they touch nothing -------------
    if verb in ("finish", "fail"):
        return PolicyDecision(
            decision="allow", risk="low", rules_fired=["terminal-verb"],
            reason="reports the task outcome without touching the page",
        )

    url = observation.url if observation else ""
    name = _element_name(action, observation)

    # ---- Credentials: allowed only into the site they were registered for --
    if verb == "fill_credential":
        slot = action.params.slot or ""
        if not slot:
            return PolicyDecision(
                decision="deny", risk="blocked", rules_fired=["credential-no-slot"],
                reason="fill_credential needs params.slot naming a configured credential",
            )
        try:
            vault.resolve(slot, observation.url if observation else "")
        except VaultError as exc:
            # Covers both "no such slot" and, importantly, "wrong site".
            return PolicyDecision(
                decision="deny", risk="blocked",
                rules_fired=["credential-binding-refused"], reason=str(exc),
            )
        return PolicyDecision(
            decision="allow", risk="low",
            rules_fired=["credential-slot:" + slot, "site-binding-verified"],
            reason="filling a credential the operator registered for this exact site; "
                   "the value is never shown to the model",
        )

    # ---- Uploading a file is a disclosure; a human confirms it -------------
    if verb == "upload_file":
        return PolicyDecision(
            decision="confirm", risk="high",
            rules_fired=["file-upload"],
            reason="uploading a file sends its contents to the site",
        )

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
        # Entering an authentication code or a password is the one class a
        # standing pre-authorisation must never cover. Everything else about a
        # task can be approved once up front; completing a second factor is the
        # step that is supposed to require a person, and a machine that walks
        # through it unattended has removed the only thing it was there for.
        live = [r for r in rules if r in ALWAYS_LIVE_RULES]
        return PolicyDecision(
            decision="confirm",
            risk="high",
            rules_fired=rules + (["requires-live-human"] if live else []),
            reason="needs a human decision: " + "; ".join(rules)
                   + ("; an authentication code cannot be pre-approved"
                      if live else ""),
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
    if verb == "fill_credential":
        return "fill the saved credential %s (value never shown or logged)" % (
            action.params.slot or "?")
    if verb == "upload_file":
        return "upload the file %s" % (action.params.file_path or "?")
    if verb == "download":
        return "download " + (action.params.url or "the current link")
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
