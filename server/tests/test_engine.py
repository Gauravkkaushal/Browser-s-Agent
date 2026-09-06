"""Tests for the deterministic parts of the engine.

Everything here runs without a browser and without a model: the policy layer,
the verifier and the schema validation are pure functions by design, which is
exactly what makes them trustworthy.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from server.knowledge import GENERIC_HINTS, hints_for
from server.policy import evaluate
from server.schemas import (
    ActionProposal, InteractiveElement, Observation, PageState, TabInfo,
)
from server.verifier import verify


def obs(url="https://example.com/", elements=None, **kw) -> Observation:
    return Observation(
        url=url,
        title=kw.pop("title", "Example"),
        interactive_elements=elements or [],
        page_state=kw.pop("page_state", PageState()),
        scroll=kw.pop("scroll", {"x": 0, "y": 0, "max_y": 0}),
        tabs=kw.pop("tabs", []),
        **kw,
    )


def el(eid, role="button", name="", **kw) -> InteractiveElement:
    return InteractiveElement(eid=eid, nid="deadbeef", role=role, name=name,
                              box=[0, 0, 100, 30], **kw)


def act(action="click", element_id=None, **params) -> ActionProposal:
    return ActionProposal.model_validate({
        "action": action,
        "target": {"element_id": element_id},
        "params": params,
        "reason": "test",
        "confidence": 0.9,
    })


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------
class TestSchema:
    def test_rejects_an_invented_verb(self):
        with pytest.raises(ValidationError):
            ActionProposal.model_validate({"action": "execute_javascript"})

    def test_rejects_a_shell_style_verb(self):
        with pytest.raises(ValidationError):
            ActionProposal.model_validate({"action": "run_script"})

    def test_accepts_every_documented_verb(self):
        for verb in ["navigate", "click", "type", "extract", "finish", "fail"]:
            assert ActionProposal.model_validate({"action": verb}).action == verb

    def test_clamps_confidence(self):
        assert ActionProposal.model_validate({"action": "click", "confidence": 9}).confidence == 1.0


# ---------------------------------------------------------------------------
# Policy -- the gate the model cannot argue past
# ---------------------------------------------------------------------------
class TestPolicy:
    def test_navigation_is_allowed_unattended(self):
        d = evaluate(act("navigate", url="https://example.com"), obs())
        assert d.decision == "allow" and d.risk == "low"

    def test_clicking_a_plain_link_is_allowed(self):
        o = obs(elements=[el("e1", role="link", name="More information", href="https://iana.org")])
        assert evaluate(act("click", "e1"), o).decision == "allow"

    def test_a_send_button_needs_a_human(self):
        o = obs(elements=[el("e1", name="Send")])
        d = evaluate(act("click", "e1"), o)
        assert d.decision == "confirm" and d.risk == "high"
        assert any("high-risk-control-name" in r for r in d.rules_fired)

    @pytest.mark.parametrize("label", [
        "Pay now", "Place order", "Buy Now", "Checkout", "Delete", "Confirm",
        "Transfer", "Post", "Purchase",
    ])
    def test_every_consequential_control_needs_a_human(self, label):
        o = obs(elements=[el("e1", name=label)])
        assert evaluate(act("click", "e1"), o).decision == "confirm"

    def test_submit_always_needs_a_human(self):
        o = obs(elements=[el("e1", role="button", name="Go")])
        d = evaluate(act("submit", "e1"), o)
        assert d.decision == "confirm" and "submit-verb" in d.rules_fired

    def test_typing_into_a_password_field_needs_a_human(self):
        o = obs(elements=[el("e1", role="textbox", name="Password",
                             input_type="password", is_editable=True, is_protected=True)])
        d = evaluate(act("type", "e1", text="secret"), o)
        assert d.decision == "confirm"
        assert "protected-field" in d.rules_fired

    def test_typing_an_ordinary_query_is_allowed(self):
        o = obs(elements=[el("e1", role="textbox", name="Search", is_editable=True)])
        assert evaluate(act("type", "e1", text="running shoes"), o).decision == "allow"

    def test_any_action_on_a_checkout_url_needs_a_human(self):
        o = obs(url="https://shop.example.com/checkout/step2",
                elements=[el("e1", name="Continue")])
        d = evaluate(act("click", "e1"), o)
        assert d.decision == "confirm" and "high-risk-url" in d.rules_fired

    def test_closing_a_foreign_tab_is_refused_outright(self):
        o = obs(tabs=[TabInfo(tab_id=7, url="https://example.com", agent_owned=False)])
        d = evaluate(ActionProposal.model_validate(
            {"action": "close_tab", "target": {"tab_id": 7}}), o)
        assert d.decision == "deny"

    def test_closing_an_agent_owned_tab_is_allowed(self):
        o = obs(tabs=[TabInfo(tab_id=7, url="https://example.com", agent_owned=True)])
        d = evaluate(ActionProposal.model_validate(
            {"action": "close_tab", "target": {"tab_id": 7}}), o)
        assert d.decision == "allow"

    def test_every_decision_records_why(self):
        o = obs(elements=[el("e1", name="Send")])
        d = evaluate(act("click", "e1"), o)
        assert d.rules_fired and d.reason


# ---------------------------------------------------------------------------
# Verifier
# ---------------------------------------------------------------------------
class TestVerifier:
    def test_a_met_url_expectation_is_success(self):
        a = ActionProposal.model_validate({
            "action": "navigate",
            "params": {"url": "https://iana.org",
                       "expected": {"url_contains": "iana.org"}},
        })
        v = verify(a, obs("https://example.com/"), obs("https://www.iana.org/help"), {})
        assert v.verdict == "success"

    def test_an_unmet_url_expectation_is_failure(self):
        a = ActionProposal.model_validate({
            "action": "click", "params": {"expected": {"url_contains": "checkout"}},
        })
        v = verify(a, obs("https://example.com/"), obs("https://example.com/"), {})
        assert v.verdict == "failed"

    def test_typing_is_judged_by_the_field_readback_not_by_hope(self):
        a = act("type", "e1", text="hello")
        ok = verify(a, obs(), obs(), {"verified": True, "strategy": "execCommand:insertText"})
        bad = verify(a, obs(), obs(), {"verified": False})
        assert ok.verdict == "success"
        assert bad.verdict == "failed"

    def test_extraction_with_no_items_is_a_failure_not_a_pass(self):
        v = verify(act("extract"), obs(), obs(), {"items": [], "reason": "no groups"})
        assert v.verdict == "failed"

    def test_a_navigation_that_did_not_move_is_a_failure(self):
        v = verify(act("navigate", url="https://iana.org"),
                   obs("https://example.com/"), obs("https://example.com/"), {})
        assert v.verdict == "failed"

    def test_no_observable_change_is_uncertain_not_success(self):
        v = verify(act("click", "e1"), obs(), obs(), {})
        assert v.verdict == "uncertain"


# ---------------------------------------------------------------------------
# Knowledge packs are advice, never control flow
# ---------------------------------------------------------------------------
class TestKnowledge:
    def test_an_unknown_site_still_gets_usable_guidance(self):
        assert hints_for("https://some-shop-nobody-knows.example/") == GENERIC_HINTS

    def test_a_known_host_gets_its_pack(self):
        assert "composer" in hints_for("https://web.whatsapp.com/").lower() or \
               "contenteditable" in hints_for("https://web.whatsapp.com/").lower()

    def test_hints_are_plain_text_advice(self):
        for url in ["https://web.whatsapp.com/", "https://mail.google.com/", "https://x.invalid/"]:
            assert isinstance(hints_for(url), str)
