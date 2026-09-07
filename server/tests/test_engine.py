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


# ---------------------------------------------------------------------------
# The loop breaker must not confuse different actions for repeats
# ---------------------------------------------------------------------------
class TestRepeatSignature:
    def _sig(self, action, url="https://chat.example/"):
        o = Observation(url=url)
        return "%s|%s|%s|%s|tab=%s|on=%s" % (
            action.action,
            action.target.nid or action.target.element_id or "",
            (action.target.name or "")[:40],
            (action.params.text or action.params.url or action.params.key_combo or "")[:40],
            action.target.tab_id if action.target.tab_id is not None else "-",
            o.url[:80],
        )

    def test_switching_to_two_different_tabs_is_two_different_actions(self):
        # This exact collision blocked the agent from reaching ChatGPT after it
        # had already switched to another tab.
        a = ActionProposal.model_validate({"action": "switch_tab", "target": {"tab_id": 11}})
        b = ActionProposal.model_validate({"action": "switch_tab", "target": {"tab_id": 22}})
        assert self._sig(a) != self._sig(b)

    def test_the_same_click_on_a_different_page_is_a_different_action(self):
        a = ActionProposal.model_validate({"action": "click", "target": {"element_id": "e1"}})
        assert self._sig(a, "https://a.example/") != self._sig(a, "https://b.example/")

    def test_the_genuinely_identical_action_still_collides(self):
        a = ActionProposal.model_validate({"action": "click", "target": {"element_id": "e1"}})
        b = ActionProposal.model_validate({"action": "click", "target": {"element_id": "e1"}})
        assert self._sig(a) == self._sig(b)


# --- standing authorisation ------------------------------------------------
#
# Being asked to approve the same class of action over and over is what left a
# message unsent: the window loses focus, nobody answers in time, and the send
# is dropped. One answer has to be able to cover the rest of the task -- with
# the single exception that no answer ever covers an authentication code.

def test_approving_for_the_task_stops_the_agent_asking_again():
    from server.loop import Task

    task = Task("send gaurav the link")
    assert task.pre_approved is False
    task.confirm(True, scope="task")
    assert task.pre_approved is True


def test_approving_once_does_not_widen_to_the_whole_task():
    from server.loop import Task

    task = Task("send gaurav the link")
    task.confirm(True, scope="once")
    assert task.pre_approved is False


def test_declining_never_grants_a_standing_authorisation():
    from server.loop import Task

    task = Task("send gaurav the link")
    task.confirm(False, scope="task")
    assert task.pre_approved is False


def test_an_authentication_code_is_still_marked_live_under_pre_approval():
    """Pre-approval covers sending and paying. It must never cover a 2FA code."""
    obs = Observation(
        url="https://lms.kiet.edu/login/",
        title="Log in",
        interactive_elements=[
            InteractiveElement(eid="e1", role="textbox", name="One-time code",
                               input_type="text", is_editable=True),
        ],
    )
    action = ActionProposal.model_validate({
        "action": "type", "reason": "enter the code",
        "target": {"element_id": "e1"},
        "params": {"text": "123456"},
    })
    decision = evaluate(action, obs)
    assert decision.decision == "confirm"
    assert "requires-live-human" in decision.rules_fired


# --- clicking a composer is not sending anything ---------------------------
#
# WhatsApp, ChatGPT and half the web label their message box "Send a message".
# Asking a human to approve putting the caret in a text box is noise, and noise
# is what teaches someone to approve without reading. The real Send button is
# not editable, so it must still stop.

def test_focusing_a_composer_named_send_a_message_is_not_high_risk():
    o = obs(elements=[el("e1", role="textbox", name="Send a Message", is_editable=True)])
    d = evaluate(act("click", "e1"), o)
    assert d.decision == "allow"
    assert not any("high-risk-control-name" in r for r in d.rules_fired)


def test_a_searchbox_named_send_is_not_high_risk():
    o = obs(elements=[el("e1", role="searchbox", name="Send to...")])
    assert evaluate(act("click", "e1"), o).decision == "allow"


def test_the_actual_send_button_still_stops_for_a_human():
    o = obs(elements=[el("e1", role="button", name="Send", is_editable=False)])
    d = evaluate(act("click", "e1"), o)
    assert d.decision == "confirm"
    assert any("high-risk-control-name" in r for r in d.rules_fired)


def test_typing_into_a_composer_named_send_a_message_stays_allowed():
    o = obs(elements=[el("e1", role="textbox", name="Send a Message", is_editable=True)])
    assert evaluate(act("type", "e1", text="hi"), o).decision == "allow"


# --- tabs must be identifiable, not guessed at -----------------------------
#
# The reasoner picked a leftover chat.z.ai tab because a truncated url looked
# like a chat app. It could not see the titles, so it could not tell that the
# tab it wanted was the one called "WhatsApp".

def test_the_digest_names_every_tab_so_one_can_be_told_from_another():
    from server.reasoner import _observation_digest

    o = obs(tabs=[
        TabInfo(tab_id=1, url="https://chat.z.ai/c/5388", title="Z.ai", active=True),
        TabInfo(tab_id=2, url="https://web.whatsapp.com/", title="WhatsApp"),
    ])
    digest = _observation_digest(o, tier=0)
    titles = [t["title"] for t in digest["tabs"]]
    assert "WhatsApp" in titles
    assert "Z.ai" in titles


# --- not every message is a task -------------------------------------------
#
# "hello" was being turned into a plan ("Acknowledge the user's greeting"),
# which then died because no ordinary web page happened to be open. Announcing
# a plan to say hello and then failing is a worse answer than saying nothing.

def _plan_from(payload, command="hello", **kw):
    import asyncio

    from server import llm, planner

    async def fake_call(role, system, user, **_):
        return payload

    original = llm.call
    llm.call = fake_call
    try:
        return asyncio.run(planner.make_plan(command, "task_test", **kw))
    finally:
        llm.call = original


def test_a_greeting_is_answered_not_planned():
    plan = _plan_from({"reply": "Hello. What would you like me to do?"})
    assert plan.steps == []
    assert plan.reply.startswith("Hello")


def test_a_real_request_is_still_planned_even_with_a_reply_present():
    """A model that returns both is proposing work; the work wins."""
    plan = _plan_from(
        {"reply": "Sure!", "objective": "find a bat",
         "steps": [{"n": 1, "goal": "search for bats", "done_when": "results shown"}]},
        command="find me the cheapest bat",
    )
    assert plan.reply == ""
    assert len(plan.steps) == 1


def test_replanning_mid_task_can_never_collapse_into_chat():
    """Real work is already underway; "just reply" is never the answer to that."""
    plan = _plan_from({"reply": "ok"}, command="do what he asked",
                      discovered="he asked for the bat link")
    assert plan.reply == ""
    assert plan.steps  # falls back to carrying the command out


# --- is Chrome even running the code we just wrote? ------------------------
#
# Tab resolution, navigation and screenshots all live in the service worker,
# and Chrome keeps running the OLD one until the extension is reloaded. Without
# a build id the server cannot tell a fixed agent from a stale one -- which is
# how the same bug gets reported as unfixed three times in a row.

def test_the_service_worker_carries_a_build_id():
    from pathlib import Path
    import re

    src = (Path(__file__).parent.parent.parent / "public" / "agent-background.js").read_text(
        encoding="utf-8")
    assert re.search(r"const AGENT_SW_BUILD = '[^']+'", src), \
        "agent-background.js must declare AGENT_SW_BUILD"
    assert "sw_build: AGENT_SW_BUILD" in src, \
        "the worker must report its build id when it connects"


def test_the_server_can_read_the_expected_worker_build():
    from server.browser_bridge import _expected_sw_build

    assert _expected_sw_build(), "the server must be able to read the shipped build id"


def test_a_stale_worker_is_reported_loudly():
    import asyncio

    from server.browser_bridge import BrowserBridge, _expected_sw_build
    from server.events import bus

    seen = []

    class FakeSocket:
        async def send_json(self, _):
            return None

    async def run():
        original = bus.emit

        async def capture(event_type, payload, **kw):
            seen.append((event_type, payload))

        bus.emit = capture
        try:
            b = BrowserBridge()
            await b.attach(FakeSocket(), "sess", sw_build="sw-ancient")
        finally:
            bus.emit = original

    asyncio.run(run())
    errors = [p for t, p in seen if t == "ERROR"]
    assert errors and errors[0].get("stale_service_worker") is True
    assert _expected_sw_build() in errors[0]["error"]


def test_a_current_worker_raises_no_alarm():
    import asyncio

    from server.browser_bridge import BrowserBridge, _expected_sw_build
    from server.events import bus

    seen = []

    class FakeSocket:
        async def send_json(self, _):
            return None

    async def run():
        original = bus.emit

        async def capture(event_type, payload, **kw):
            seen.append((event_type, payload))

        bus.emit = capture
        try:
            b = BrowserBridge()
            await b.attach(FakeSocket(), "sess", sw_build=_expected_sw_build())
        finally:
            bus.emit = original

    asyncio.run(run())
    assert not [p for t, p in seen if t == "ERROR"]


# --- documents the DOM cannot show -----------------------------------------
#
# Chrome's PDF viewer is a plugin document: no text, no controls. The agent
# scrolled, waited, switched tabs and gave up on a paper whose words were
# simply never in the DOM.

def test_a_pdf_with_no_text_is_named_as_a_scan_not_a_mystery():
    """The distinction matters: one is worth retrying, the other never is."""
    import base64
    import io

    from pypdf import PdfWriter

    from server.documents import DocumentError, extract_pdf_text

    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    buf = io.BytesIO()
    writer.write(buf)

    try:
        extract_pdf_text(base64.b64encode(buf.getvalue()).decode())
    except DocumentError as exc:
        assert "scan" in str(exc).lower() or "no extractable text" in str(exc).lower()
    else:
        raise AssertionError("a blank PDF must not be reported as readable")


def test_rubbish_is_not_silently_accepted_as_a_pdf():
    import base64

    from server.documents import DocumentError, extract_pdf_text

    try:
        extract_pdf_text(base64.b64encode(b"this is not a pdf at all").decode())
    except DocumentError as exc:
        assert "pdf" in str(exc).lower()
    else:
        raise AssertionError("non-PDF bytes must be rejected")


def test_bad_base64_is_reported_clearly():
    from server.documents import DocumentError, extract_pdf_text

    try:
        extract_pdf_text("!!!! not base64 !!!!")
    except DocumentError as exc:
        assert "base64" in str(exc).lower()
    else:
        raise AssertionError("invalid base64 must be rejected")


def test_the_walker_knows_a_pdf_when_it_sees_one():
    from pathlib import Path

    src = (Path(__file__).parent.parent.parent / "public" / "agent-content.js").read_text(
        encoding="utf-8")
    assert "function detectPageKind()" in src
    assert "application/pdf" in src
    assert "page_kind: detectPageKind()" in src


def test_the_bytes_are_fetched_from_the_page_so_a_login_still_works():
    """A server-side fetch of a PDF behind a login gets the sign-in page back."""
    from pathlib import Path

    src = (Path(__file__).parent.parent.parent / "public" / "agent-content.js").read_text(
        encoding="utf-8")
    assert "credentials: 'include'" in src


# --- a badly shaped reply costs a step, not the task -----------------------
#
# A multi-site run -- Google Meet link, then WhatsApp -- died at the final hop
# because the model wrote `expected: 'https://meet.google.com/'` instead of
# `expected: {url_contains: ...}`. Everything else about the step was right.
# Killing a task over the shape of one optional field is not validation, it is
# brittleness.

class TestForgivingShapes:
    def test_expected_as_a_bare_url_is_read_as_a_url_prediction(self):
        a = ActionProposal.model_validate({
            "action": "click", "reason": "t",
            "params": {"expected": "https://meet.google.com/"},
        })
        assert a.params.expected.url_contains == "https://meet.google.com/"

    def test_expected_as_a_bare_phrase_is_read_as_a_text_prediction(self):
        a = ActionProposal.model_validate({
            "action": "click", "reason": "t",
            "params": {"expected": "Start an instant meeting"},
        })
        assert a.params.expected.text_contains == "Start an instant meeting"

    def test_expected_wrapped_in_a_list_is_unwrapped(self):
        a = ActionProposal.model_validate({
            "action": "click", "reason": "t",
            "params": {"expected": [{"text_contains": "Meeting ready"}]},
        })
        assert a.params.expected.text_contains == "Meeting ready"

    def test_an_empty_expected_string_is_simply_absent(self):
        a = ActionProposal.model_validate({
            "action": "click", "reason": "t", "params": {"expected": "   "},
        })
        assert a.params.expected is None

    def test_a_proper_expected_object_is_untouched(self):
        a = ActionProposal.model_validate({
            "action": "click", "reason": "t",
            "params": {"expected": {"element_gone": "meet link"}},
        })
        assert a.params.expected.element_gone == "meet link"

    def test_target_given_as_a_bare_eid_still_means_that_element(self):
        a = ActionProposal.model_validate({"action": "click", "target": "e17"})
        assert a.target.element_id == "e17"

    def test_the_verb_whitelist_is_still_absolute(self):
        """Forgiveness is about SHAPE. It must never widen what may be done."""
        with pytest.raises(ValidationError):
            ActionProposal.model_validate({"action": "execute_javascript"})
        with pytest.raises(ValidationError):
            ActionProposal.model_validate({"action": "run_shell", "target": "e1"})


def test_an_unreadable_reply_is_a_dedicated_error_the_loop_can_absorb():
    from server.loop import Task
    from server.reasoner import MalformedAction

    # The loop must catch this by type rather than letting it become a fatal
    # RuntimeError, which is what ended the Meet -> WhatsApp run.
    import inspect
    src = inspect.getsource(Task.step_once)
    assert "except MalformedAction" in src
    assert "return None" in src


# --- reading a page the browser will not let us read -----------------------
#
# chrome://, the Web Store and Chrome's PDF viewer are closed to content
# scripts by the browser itself. There is no DOM, no retry that helps, and
# "Stopped: no ordinary web page is open" was the agent giving up on a page
# that was plainly visible on screen. A screenshot is the only way in -- and
# the honest part is saying so, because masking needs the very content script
# those pages refuse to run.

class TestReadingBySight:
    def test_pii_in_a_transcription_is_redacted_before_it_is_stored(self):
        from server.redaction import redact_text

        text, counts = redact_text(
            "Call Gaurav on +91 95577 00749 or mail harsh@example.com")
        assert "95577" not in text
        assert "harsh@example.com" not in text
        assert counts["PHONE"] == 1 and counts["EMAIL"] == 1

    def test_ordinary_words_survive_redaction(self):
        from server.redaction import redact_text

        text, counts = redact_text("AptiQuest 2026 meeting on 21/8/2026 at 6:16pm")
        assert text == "AptiQuest 2026 meeting on 21/8/2026 at 6:16pm"
        assert counts == {}

    def test_the_python_and_page_redactors_cover_the_same_kinds(self):
        """Two copies of a privacy rule must not drift apart silently."""
        import re
        from pathlib import Path

        from server.redaction import PATTERNS

        src = (Path(__file__).parent.parent.parent / "public" / "agent-content.js").read_text(
            encoding="utf-8")
        block = src.split("const PII_PATTERNS = [")[1].split("\n]")[0]
        in_page = set(re.findall(r"type:\s*'([A-Z]+)'", block))
        in_python = {kind for kind, _ in PATTERNS}
        assert in_python == in_page, (
            "redaction.py and agent-content.js disagree: only in page %s, only in python %s"
            % (in_page - in_python, in_python - in_page))

    def test_an_unmaskable_capture_says_so_rather_than_implying_redaction(self):
        from pathlib import Path

        src = (Path(__file__).parent.parent.parent / "public" / "agent-background.js").read_text(
            encoding="utf-8")
        assert "mask_note" in src
        assert "the capture is unredacted" in src

    def test_the_observation_records_that_it_came_from_a_screenshot(self):
        from server.schemas import Observation

        assert Observation().read_by_sight is False
        assert Observation(read_by_sight=True).read_by_sight is True

    def test_a_closed_page_is_recognised_as_closed_not_as_a_fault_to_retry(self):
        from server.loop import _UNREADABLE_PAGE

        for message in [
            "cannot operate on this page (chrome://extensions)",
            "no ordinary web page is open for the agent to work in",
            "the page in front of you is chrome-extension://..., which extensions cannot read",
        ]:
            assert _UNREADABLE_PAGE.search(message), message
        assert not _UNREADABLE_PAGE.search("browser did not answer 'observe' within 90s")


# --- masking that can be checked -------------------------------------------
#
# A real run reported "2246 PII Masked" while the one phone number visible on
# screen sat unmasked in the contact panel. Both halves were wrong: the count
# was meaningless, and the scan never reached the panel.

def test_one_secret_in_many_places_counts_as_one():
    from pathlib import Path

    src = (Path(__file__).parent.parent.parent / "public" / "agent-content.js").read_text(
        encoding="utf-8")
    # Distinct values, with occurrences reported separately.
    assert "redactedValues[type].size" in src
    assert "redactionOccurrences" in src
    assert "pii_occurrences" in src


def test_the_scan_reaches_past_the_start_of_a_long_page():
    """Capped at 900 in DOM order, it never reached a right-hand side panel."""
    import re
    from pathlib import Path

    src = (Path(__file__).parent.parent.parent / "public" / "agent-content.js").read_text(
        encoding="utf-8")
    block = src.split("const blocks = Array.from(document.querySelectorAll(")[1][:400]
    cap = int(re.search(r"\.slice\(0,\s*(\d+)\)", block).group(1))
    assert cap >= 5000, "the PII scan stops after %d elements; a chat app has more" % cap


def test_every_mask_says_what_it_covers_and_never_the_value():
    from pathlib import Path

    src = (Path(__file__).parent.parent.parent / "public" / "agent-content.js").read_text(
        encoding="utf-8")
    assert "maskedRegions.push({" in src
    assert "kind: kindsIn(own)" in src
    # The region record carries a kind and a box. If it ever carried the text
    # itself, the report would leak exactly what it claims to hide.
    region = src.split("maskedRegions.push({")[1].split("})")[0]
    assert "own" not in region.replace("kindsIn(own)", ""), \
        "a mask report must never carry the redacted text"


def test_the_kind_probe_never_returns_the_matched_text():
    from pathlib import Path

    src = (Path(__file__).parent.parent.parent / "public" / "agent-content.js").read_text(
        encoding="utf-8")
    body = src.split("function kindsIn(text) {")[1].split("\n}")[0]
    assert "out.push(p.type)" in body
    assert "match" not in body


# --- a dead ladder should say what to do -----------------------------------

def test_an_exhausted_quota_is_explained_not_dumped():
    from server.llm import _explain_chain_failure

    msg = _explain_chain_failure(["groq: HTTP 429 rate limited"])
    assert "REQUESTS PER DAY" in msg and "flash-lite" in msg


def test_out_of_credit_is_named_as_out_of_credit():
    from server.llm import _explain_chain_failure

    assert "out of credit" in _explain_chain_failure(["openrouter: HTTP 402"])


def test_a_retired_model_is_named_as_retired():
    from server.llm import _explain_chain_failure

    msg = _explain_chain_failure(["gemini: HTTP 404 This model is no longer available"])
    assert "retired" in msg


def test_the_light_rungs_come_first_in_the_shipped_ladder():
    """Full Flash allows 20 requests a day; Lite allows 500."""
    from server import config

    first = config.GEMINI_REASONER_MODELS[0]
    assert "lite" in first.lower(), \
        "the first reasoner rung is %r, which spends the day's quota in one task" % first
    assert not any("2.5-flash" == m for m in config.GEMINI_REASONER_MODELS), \
        "gemini-2.5-flash is retired and answers 404"


# --- several keys, and one of them dead ------------------------------------
#
# The free tier counts requests-per-DAY per key, so a second key is a second
# day's allowance. But a revoked key answers 403 on EVERY model, so unless it
# is dropped it fails every rung of the ladder in turn while the working keys
# sit unused behind it.

def test_more_than_one_gemini_key_is_loaded():
    from server import config

    assert isinstance(config.GEMINI_API_KEYS, list)
    assert config.GEMINI_API_KEY == (config.GEMINI_API_KEYS[0]
                                     if config.GEMINI_API_KEYS else "")


def test_a_key_list_survives_stray_spaces_and_empty_entries():
    from server.config import split_keys

    assert split_keys(" a , b ,, c ") == ["a", "b", "c"]
    assert split_keys("solo") == ["solo"]
    assert split_keys("") == []
    assert split_keys(None) == []


def test_a_refused_key_is_dropped_rather_than_retried_on_every_rung():
    import inspect

    from server.llm import Gemini

    src = inspect.getsource(Gemini.complete)
    assert "dead" in src, "a permanently refused key must be remembered"
    assert "(401, 403)" in src, "401/403 means the key is refused, not throttled"
    # And a throttled key must still be distinguished from a refused one.
    assert "(429, 503)" in src


# --- having nowhere to stand is not a failure ------------------------------
#
# "generate a google meet link and send it to the sih group" died on "no
# ordinary web page is open" -- while the browser sat there perfectly able to
# open one. Opening a tab is what a person would do before declaring the job
# impossible.

def test_the_loop_opens_a_page_rather_than_giving_up():
    import inspect

    from server.loop import Task

    src = inspect.getsource(Task._first_observation)
    assert "open_tab" in src
    assert "FALLBACK_START_URL" in src


def test_the_fallback_landing_page_is_one_an_extension_can_actually_read():
    from server import config

    # about:blank and chrome:// are not injectable, so a fallback that used one
    # would land the agent right back where it started.
    assert config.FALLBACK_START_URL.startswith(("http://", "https://"))


def test_only_a_closed_page_triggers_opening_one():
    """A timeout or a crashed extension must not be answered by a new tab."""
    import inspect

    from server.loop import Task

    src = inspect.getsource(Task._first_observation)
    assert "_UNREADABLE_PAGE.search" in src
    assert "raise" in src


def test_the_planner_is_told_start_url_is_required():
    from server.planner import SYSTEM

    assert "start_url is REQUIRED" in SYSTEM


# --- a click that undid itself ---------------------------------------------
#
# "click New meeting" reported "did not take effect" five times in a row. The
# click was landing: the menu opened, the element-count heuristic could not see
# it within 120ms, and the native fallback fired a SECOND click that closed the
# menu again. Every attempt cancelled itself, so the page really was unchanged
# and the agent really did keep trying.

def test_the_click_fallback_waits_for_a_reaction_before_firing_again():
    from pathlib import Path

    src = (Path(__file__).parent.parent.parent / "public" / "agent-content.js").read_text(
        encoding="utf-8")
    body = src.split("async function doClick(el) {")[1].split("\nfunction nativeSetValue")[0]
    assert "MutationObserver" in body, \
        "a node COUNT cannot see a menu opening; watch for mutations"
    assert "if (!reacted)" in body, \
        "the native fallback must only fire when nothing at all happened"
    assert "document.querySelectorAll('*').length === before" not in body, \
        "the count heuristic is what made a toggle undo itself"


def test_a_click_the_page_responded_to_is_not_reported_as_failed():
    o = obs(elements=[el("e1", role="button", name="New meeting")])
    a = act("click", "e1")
    v = verify(a, o, o, {"clicked": True, "page_reacted": True})
    assert v.verdict != "failed"
    assert any("reacted" in s for s in v.signals)


def test_a_click_nothing_responded_to_is_still_reported_honestly():
    o = obs(elements=[el("e1", role="button", name="New meeting")])
    a = act("click", "e1")
    v = verify(a, o, o, {"clicked": True, "page_reacted": False})
    assert v.verdict == "uncertain"
    assert any("no observable change" in s for s in v.signals)


def test_a_reaction_alone_is_enough_to_call_a_click_successful():
    """Otherwise the agent goes back and presses the same toggle again."""
    o = obs(elements=[el("e1", role="button", name="New meeting")])
    v = verify(act("click", "e1"), o, o, {"clicked": True, "page_reacted": True})
    assert v.verdict == "success"
