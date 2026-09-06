"""Authoritative wire contracts.

Every WebSocket message in either direction is an Envelope. Every action the
reasoner emits is validated against ActionProposal before the policy layer even
sees it -- the model cannot invent a verb.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, field_validator


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Event envelope
# ---------------------------------------------------------------------------
EVENT_TYPES = {
    "TASK_CREATED", "PLAN_GENERATED", "OBSERVATION_RECEIVED", "ACTION_PROPOSED",
    "POLICY_APPROVED", "POLICY_DENIED", "CONFIRMATION_REQUESTED",
    "CONFIRMATION_GRANTED", "CONFIRMATION_DENIED", "ACTION_EXECUTING",
    "ACTION_EXECUTED", "ACTION_FAILED", "ACTION_VERIFIED", "VERIFICATION_FAILED",
    "RECOVERY_STARTED", "RECOVERY_COMPLETED", "LOGIN_REQUIRED", "LOGIN_DETECTED",
    "TASK_COMPLETED", "TASK_FAILED", "TASK_CANCELLED", "MODEL_CALL_COMPLETED",
    "WS_CONNECTED", "WS_DISCONNECTED", "ERROR",
    # What was hidden from the model, emitted every step so it can be watched.
    "MASKING_APPLIED", "SECURITY_BLOCKED", "QUOTED_MESSAGE_READY",
    "DOCUMENT_READ", "PAGE_READ_BY_SIGHT",
    # transport-level, not part of the task narrative
    "PING", "PONG", "BRIDGE_REQUEST", "BRIDGE_RESPONSE", "STATE_CHANGED",
}


class Envelope(BaseModel):
    v: int = 1
    type: str
    ts: str = Field(default_factory=now_iso)
    task_id: Optional[str] = None
    step: int = 0
    seq: int = 0
    payload: Dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Observation
# ---------------------------------------------------------------------------
class InteractiveElement(BaseModel):
    eid: str
    nid: str = ""
    role: str = "generic"
    name: str = ""
    text: str = ""
    tag: str = ""
    box: List[int] = Field(default_factory=list)
    in_viewport: bool = False
    is_editable: bool = False
    input_type: str = ""
    href: str = ""
    value: str = ""
    is_protected: bool = False
    path: str = ""


class LoginWall(BaseModel):
    app: str = "generic"
    kind: str = "credential"
    hint: str = ""


class PageState(BaseModel):
    loading: bool = False
    overlay_present: bool = False
    login_wall: Optional[LoginWall] = None


class TabInfo(BaseModel):
    tab_id: int
    url: str = ""
    title: str = ""
    active: bool = False
    agent_owned: bool = False


class Observation(BaseModel):
    url: str = ""
    title: str = ""
    tabs: List[TabInfo] = Field(default_factory=list)
    active_tab_id: Optional[int] = None
    viewport: Dict[str, Any] = Field(default_factory=dict)
    scroll: Dict[str, Any] = Field(default_factory=dict)
    page_state: PageState = Field(default_factory=PageState)
    interactive_elements: List[InteractiveElement] = Field(default_factory=list)
    page_text: str = ""
    # "html", or "pdf" when Chrome is showing a plugin document whose words are
    # not in the DOM at all. The loop reads those by fetching the file instead.
    page_kind: str = "html"
    # True when this page could only be read from a screenshot, because the
    # browser forbids content scripts there. Recorded so the UI can say so.
    read_by_sight: bool = False
    mask_note: str = ""
    dom_summary: Dict[str, Any] = Field(default_factory=dict)
    focused_element: Optional[Dict[str, Any]] = None
    screenshot: Optional[str] = None
    screenshot_error: Optional[str] = None
    sensitive_boxes: List[List[int]] = Field(default_factory=list)
    errors: List[str] = Field(default_factory=list)
    # DISTINCT values hidden, per kind. The number of PLACES each was hidden
    # in is separate: one phone number nested in a dozen containers is one
    # secret, not a dozen, and reporting it as a dozen made the panel useless.
    pii_redactions: Dict[str, int] = Field(default_factory=dict)
    pii_occurrences: Dict[str, int] = Field(default_factory=dict)
    # What each blacked-out box covers. The KIND and its position, never the
    # value -- so a claim of redaction can actually be checked.
    masked_regions: List[Dict[str, Any]] = Field(default_factory=list)
    walk_ms: int = 0
    agent_build: str = ""
    # Set when the page being observed is NOT the tab the user is looking at.
    user_tab_note: Optional[str] = None
    observed_at: str = Field(default_factory=now_iso)

    def element(self, eid: str) -> Optional[InteractiveElement]:
        for el in self.interactive_elements:
            if el.eid == eid:
                return el
        return None


# ---------------------------------------------------------------------------
# ActionProposal
# ---------------------------------------------------------------------------
ALLOWED_ACTIONS = [
    "navigate", "open_tab", "switch_tab", "close_tab", "back", "forward",
    "click", "type", "keypress", "scroll", "hover", "focus", "select",
    "wait", "extract", "screenshot", "submit",
    "fill_credential", "download", "upload_file", "list_downloads",
    "replan", "note", "request_quoted_message",
    "finish", "fail",
]

# Verbs the service worker owns; everything else goes to the content script.
BROWSER_VERBS = {
    "navigate", "open_tab", "switch_tab", "close_tab", "back", "forward", "screenshot",
    "download", "upload_file", "list_downloads",
}
TERMINAL_VERBS = {"finish", "fail"}
# Verbs handled entirely by the loop; they never reach the browser.
CONTROL_VERBS = {"replan", "note", "request_quoted_message"}


class ExpectedState(BaseModel):
    url_contains: Optional[str] = None
    text_contains: Optional[str] = None
    element_appears: Optional[str] = None
    element_gone: Optional[str] = None


class ActionTarget(BaseModel):
    element_id: Optional[str] = None
    tab_id: Optional[int] = None
    # Grounding fallbacks, filled in by the server from the observation --
    # never by the model.
    nid: Optional[str] = None
    name: Optional[str] = None
    path: Optional[str] = None


class ActionParams(BaseModel):
    url: Optional[str] = None
    text: Optional[str] = None
    key_combo: Optional[str] = None
    direction: Optional[str] = None
    amount_px: Optional[int] = None
    timeout_ms: Optional[int] = None
    text_contains: Optional[str] = None
    max_results: Optional[int] = None
    value: Optional[str] = None
    replace: Optional[bool] = None
    summary: Optional[str] = None
    error: Optional[str] = None
    # replan: what the agent has just learned, and what it now intends to do.
    discovered: Optional[str] = None
    objective: Optional[str] = None
    accept: Optional[bool] = None
    # A credential SLOT NAME such as "lms.password". Never a credential value:
    # the server substitutes the real secret on its way to the browser.
    slot: Optional[str] = None
    # Local file path for upload_file, and the filename filter for download.
    file_path: Optional[str] = None
    filename_contains: Optional[str] = None
    expected: Optional[ExpectedState] = None
    purpose: Optional[str] = None


    # --- Shapes the model gets wrong, corrected instead of fatal ------------
    #
    # A model that names the right verb, the right element and the right text
    # but writes `expected` as a bare string has not made a mistake worth
    # killing a task over -- and it did exactly that: a multi-site run died on
    # `expected: 'https://meet.google.com/'` after everything else was correct.
    # The intent is unmistakable, so read it rather than throw.
    @field_validator("expected", mode="before")
    @classmethod
    def _coerce_expected(cls, v: Any) -> Any:
        if v is None or isinstance(v, (dict, ExpectedState)):
            return v
        if isinstance(v, list):
            # Some models wrap it in a list. Take the first usable entry.
            for item in v:
                if isinstance(item, dict):
                    return item
            v = " ".join(str(i) for i in v)
        if isinstance(v, str):
            text = v.strip()
            if not text:
                return None
            # A url is a claim about where you will be; anything else is a
            # claim about what will be on the page.
            if text.startswith(("http://", "https://")) or "/" in text.split()[0]:
                return {"url_contains": text}
            return {"text_contains": text}
        return None


class ActionProposal(BaseModel):
    action_id: str = ""
    action: str
    target: ActionTarget = Field(default_factory=ActionTarget)
    params: ActionParams = Field(default_factory=ActionParams)
    reason: str = ""
    confidence: float = 0.5

    @field_validator("target", mode="before")
    @classmethod
    def _coerce_target(cls, v: Any) -> Any:
        """`"target": "e17"` means the element e17. Read it, do not throw."""
        if isinstance(v, str):
            return {"element_id": v.strip()} if v.strip() else {}
        if isinstance(v, int):
            return {"tab_id": v}
        return v

    @field_validator("action")
    @classmethod
    def _known_action(cls, v: str) -> str:
        if v not in ALLOWED_ACTIONS:
            raise ValueError(
                "action must be one of " + ", ".join(ALLOWED_ACTIONS) + "; got " + repr(v)
            )
        return v

    @field_validator("confidence")
    @classmethod
    def _clamp(cls, v: float) -> float:
        return max(0.0, min(1.0, float(v)))


# ---------------------------------------------------------------------------
# Plan
# ---------------------------------------------------------------------------
class PlanStep(BaseModel):
    n: int
    goal: str
    done_when: str = ""


class Plan(BaseModel):
    objective: str
    steps: List[PlanStep] = Field(default_factory=list)
    start_url: Optional[str] = None
    notes: str = ""
    # Set when the message was not a browser task at all -- a greeting, a
    # question about the agent, a remark. Then this is simply the answer, and
    # no page is opened, observed or acted on.
    reply: str = ""


# ---------------------------------------------------------------------------
# Policy
# ---------------------------------------------------------------------------
class PolicyDecision(BaseModel):
    decision: str            # allow | confirm | deny
    risk: str                # low | high | blocked
    rules_fired: List[str] = Field(default_factory=list)
    reason: str = ""


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------
class Verdict(BaseModel):
    verdict: str             # success | uncertain | failed
    signals: List[str] = Field(default_factory=list)
    reason: str = ""
