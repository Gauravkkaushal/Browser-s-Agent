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


# ---------------------------------------------------------------------------
# Finishing a task: reading IS work, but an invented answer is not
# ---------------------------------------------------------------------------
class TestFinishGuard:
    def _task(self, steps=2):
        from server.loop import Task
        from server.schemas import Plan, PlanStep
        t = Task("t")
        t.plan = Plan(objective="x", steps=[PlanStep(n=i + 1, goal="g") for i in range(steps)])
        t.step = 1
        return t

    def _finish(self, summary):
        return ActionProposal.model_validate(
            {"action": "finish", "params": {"summary": summary}})

    def test_a_read_only_answer_grounded_in_the_page_is_accepted(self):
        o = obs(url="https://mail.example.com/inbox", page_text=(
            "Cyber Vidya 3  KIET Login OTP 139216  Team Unstop  Paytm internship"))
        t = self._task()
        assert t._reject_unearned_finish(self._finish(
            "Inbox: Cyber Vidya 3 sent KIET Login OTP 139216; Team Unstop sent "
            "a Paytm internship mail."), o) is None

    def test_an_answer_the_page_does_not_support_is_rejected(self):
        o = obs(url="https://mail.example.com/inbox", page_text="Empty mailbox")
        t = self._task()
        why = t._reject_unearned_finish(self._finish(
            "Inbox: Nikhil sent Invoice 88213; Priya sent Timetable Update; "
            "Rahul sent Placement Drive Notice."), o)
        assert why is not None and "appear anywhere" in why

    def test_claiming_a_destination_the_browser_never_reached_is_rejected(self):
        o = obs(url="https://example.com/")
        t = self._task()
        why = t._reject_unearned_finish(self._finish(
            "Clicked through and reached https://www.iana.org/domains/reserved"), o)
        assert why is not None and "iana.org" in why

    def test_a_verified_action_makes_finish_credible(self):
        o = obs(url="https://example.com/")
        t = self._task()
        t.history.append({"step": 1, "summary": "click", "verdict": "verified"})
        assert t._reject_unearned_finish(self._finish("Done."), o) is None

    def test_an_empty_summary_with_no_work_done_is_rejected(self):
        o = obs(url="https://example.com/")
        assert self._task()._reject_unearned_finish(self._finish("Done."), o) is not None


# ---------------------------------------------------------------------------
# A prediction that was already true proves nothing
# ---------------------------------------------------------------------------
class TestVacuousPredictions:
    def _row(self):
        return InteractiveElement(eid="e5", role="row", name="Team chat 1:07 pm",
                                  box=[0, 0, 300, 60])

    def test_text_already_on_screen_does_not_verify_a_click(self):
        r = self._row()
        b = obs(url="https://chat.example/", elements=[r], page_text="Chats Team chat")
        a = ActionProposal.model_validate({
            "action": "click", "target": {"element_id": "e5"},
            "params": {"expected": {"text_contains": "Team chat"}}})
        v = verify(a, b, obs(url="https://chat.example/", elements=[r],
                             page_text="Chats Team chat"), {})
        assert v.verdict != "success"
        assert "will not help" in v.reason

    def test_a_genuinely_new_element_does_verify(self):
        r = self._row()
        composer = InteractiveElement(eid="e9", role="textbox", name="Type a message",
                                      is_editable=True, box=[0, 600, 500, 40])
        b = obs(url="https://chat.example/", elements=[r], page_text="Chats")
        a = ActionProposal.model_validate({
            "action": "click", "target": {"element_id": "e5"},
            "params": {"expected": {"element_appears": "Type a message"}}})
        v = verify(a, b, obs(url="https://chat.example/", elements=[r, composer],
                             page_text="Chats Type a message"), {})
        assert v.verdict == "success"

    def test_a_url_that_was_already_matching_is_not_evidence(self):
        b = obs(url="https://shop.example/search?q=shoes")
        a = ActionProposal.model_validate({
            "action": "click", "params": {"expected": {"url_contains": "shop.example"}}})
        assert verify(a, b, obs(url="https://shop.example/search?q=shoes"), {}).verdict != "success"


# ---------------------------------------------------------------------------
# Replanning: an open-ended command becomes a real one once the task is read
# ---------------------------------------------------------------------------
class TestReplan:
    def test_replan_is_a_control_verb_the_policy_waves_through(self):
        d = evaluate(ActionProposal.model_validate(
            {"action": "replan", "params": {"discovered": "send him the SIH docs"}}), obs())
        assert d.decision == "allow"
        assert "control-verb:replan" in d.rules_fired

    def test_replan_never_reaches_the_browser(self):
        from server.schemas import BROWSER_VERBS, CONTROL_VERBS
        assert "replan" in CONTROL_VERBS
        assert "replan" not in BROWSER_VERBS

    def test_the_planner_accepts_what_was_discovered(self):
        import inspect
        from server import planner
        params = inspect.signature(planner.make_plan).parameters
        assert "discovered" in params and "done_so_far" in params

    def test_replans_are_capped(self):
        from server import config
        assert 1 <= config.MAX_REPLANS <= 5


# ---------------------------------------------------------------------------
# Typing: the field's own readback outranks anything the model predicted
# ---------------------------------------------------------------------------
class TestTypingReadbackWins:
    def _type(self):
        return ActionProposal.model_validate({
            "action": "type", "target": {"element_id": "e9"},
            "params": {"text": "hello there",
                       "expected": {"text_contains": "hello there"}}})

    def test_a_failed_readback_fails_even_when_the_prediction_matches(self):
        # The exact shape of the WhatsApp bug: the text appeared somewhere on
        # the page, so the prediction passed, but the composer stayed empty and
        # the agent went on to press Send on nothing.
        after = obs(page_text="hello there appears elsewhere on this page")
        v = verify(self._type(), obs(), after, {"verified": False, "strategy": "x",
                                                "readback": ""})
        assert v.verdict == "failed"
        assert "did not land" in v.reason

    def test_a_successful_readback_passes(self):
        v = verify(self._type(), obs(), obs(),
                   {"verified": True, "strategy": "clipboard:paste"})
        assert v.verdict == "success"
        assert "clipboard:paste" in v.signals[0]


# ---------------------------------------------------------------------------
# Reading the instruction is not carrying it out
# ---------------------------------------------------------------------------
class TestPlaceholderPlanBlocksFinish:
    def _task_with(self, goals):
        from server.loop import Task
        from server.schemas import Plan, PlanStep
        t = Task("GURUBAKSH asked me to do something, complete that task")
        t.plan = Plan(objective="x",
                      steps=[PlanStep(n=i + 1, goal=g) for i, g in enumerate(goals)])
        t.step = 3
        return t

    def test_finishing_on_a_placeholder_plan_is_refused(self):
        # The real failure: the agent read "Give me the docs of SIH ps 171",
        # then declared victory without ever producing or sending the docs.
        t = self._task_with([
            "Open the chat with GURUBAKSH and read his request",
            "Complete the task requested by GURUBAKSH",
        ])
        t.history.append({"step": 1, "summary": "click", "verdict": "verified"})
        why = t._reject_unearned_finish(
            ActionProposal.model_validate({
                "action": "finish",
                "params": {"summary": "GURUBAKSH requested: 'Give me the docs of "
                                      "SIH ps 171'. Objective completed."}}),
            obs(url="https://chat.example/", page_text="Give me the docs of SIH ps 171"))
        assert why is not None
        assert "replan" in why

    def test_finishing_on_a_concrete_plan_is_allowed(self):
        t = self._task_with([
            "Search the web for SIH problem statement 171",
            "Send the summary to GURUBAKSH in the chat",
        ])
        t.history.append({"step": 1, "summary": "click", "verdict": "verified"})
        assert t._reject_unearned_finish(
            ActionProposal.model_validate({
                "action": "finish", "params": {"summary": "Sent the summary."}}),
            obs()) is None

    def test_after_replanning_the_guard_steps_aside(self):
        t = self._task_with(["Complete the task requested"])
        t._replans = 1
        t.history.append({"step": 1, "summary": "type", "verdict": "verified"})
        assert t._reject_unearned_finish(
            ActionProposal.model_validate({
                "action": "finish", "params": {"summary": "Done."}}), obs()) is None


# ---------------------------------------------------------------------------
# Notes: a fact found early must survive to the step that needs it
# ---------------------------------------------------------------------------
class TestNotes:
    def test_note_is_a_control_verb_the_policy_waves_through(self):
        d = evaluate(ActionProposal.model_validate(
            {"action": "note", "params": {"text": "PS 171 is an ISRO problem statement"}}),
            obs())
        assert d.decision == "allow"
        assert "control-verb:note" in d.rules_fired

    def test_note_never_reaches_the_browser(self):
        from server.schemas import BROWSER_VERBS, CONTROL_VERBS
        assert "note" in CONTROL_VERBS and "note" not in BROWSER_VERBS

    def test_the_reasoner_accepts_gathered_notes(self):
        import inspect
        from server import reasoner
        assert "notes" in inspect.signature(reasoner.propose).parameters


# ---------------------------------------------------------------------------
# Changing approach is exploration, not thrashing
# ---------------------------------------------------------------------------
class TestFailureCounting:
    def test_the_strike_count_resets_when_the_approach_changes(self):
        from server.loop import Task
        t = Task("t")
        # Three failures in a row, but each a different approach: the agent is
        # exploring, and killing the task there would be wrong. Identical
        # repeats are caught by the loop breaker instead.
        for sig in ("click|a|Row A|", "scroll|||down", "click|b|Row B|"):
            if sig != t._last_failed_signature:
                t.consecutive_verify_failures = 0
            t._last_failed_signature = sig
            t.consecutive_verify_failures += 1
        assert t.consecutive_verify_failures == 1


# ---------------------------------------------------------------------------
# An element that has proved useless is withheld, not merely discouraged
# ---------------------------------------------------------------------------
class TestDeadTargets:
    def _elements(self):
        return [
            InteractiveElement(eid="e1", nid="aaaa", role="row",
                               name="GURUBAKSH  Give me the docs", box=[0, 0, 300, 60]),
            InteractiveElement(eid="e2", nid="bbbb", role="textbox",
                               name="Type a message", is_editable=True,
                               box=[0, 600, 500, 40]),
        ]

    def test_a_dead_element_is_removed_from_what_the_model_can_see(self):
        from server import reasoner
        o = Observation(url="https://chat.example/", interactive_elements=self._elements())
        rows = reasoner._compact_elements(o, dead={"aaaa": "GURUBAKSH row"})
        assert [r["eid"] for r in rows] == ["e2"]

    def test_nothing_is_withheld_when_nothing_has_failed(self):
        from server import reasoner
        o = Observation(url="https://chat.example/", interactive_elements=self._elements())
        assert len(reasoner._compact_elements(o)) == 2

    def test_the_composer_survives_when_the_row_is_withheld(self):
        from server import reasoner
        o = Observation(url="https://chat.example/", interactive_elements=self._elements())
        rows = reasoner._compact_elements(o, dead={"aaaa": "x"})
        assert any(r.get("editable") for r in rows)
