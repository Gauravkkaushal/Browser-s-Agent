"""Policy tests for the bulk attendance-style submit: a click on a plainly
labeled "Submit Attendance" button must be gated exactly like any other
consequential submit, and the confirmation preview must tell a human who is
about to be marked present or absent rather than just naming the button.
"""
from __future__ import annotations

from server.policy import evaluate, redact_preview
from server.schemas import ActionProposal, InteractiveElement, Observation, PageState

from .test_engine import act, el, obs


def _roster_observation(**overrides) -> Observation:
    elements = [
        el("cb1", role="checkbox", name="Aarav Mehta", value="checked"),
        el("cb2", role="checkbox", name="Gaurav Kumar", value="unchecked"),
        el("cb3", role="checkbox", name="Nikhil Sharma", value="unchecked"),
        el("cb4", role="checkbox", name="Priya Singh", value="checked"),
        el("submit", role="button", name="Submit Attendance"),
    ]
    return obs(elements=elements, **overrides)


class TestBulkRosterSubmit:
    def test_clicking_submit_attendance_needs_a_human(self):
        o = _roster_observation()
        d = evaluate(act("click", "submit"), o)
        assert d.decision == "confirm" and d.risk == "high"
        assert "bulk-roster-submit" in d.rules_fired

    def test_plain_submit_verb_still_needs_a_human(self):
        """Regression guard: extending HIGH_RISK_NAME/BULK_ROSTER_SUBMIT_NAME
        must not loosen the pre-existing unconditional submit-verb gate."""
        o = _roster_observation()
        d = evaluate(act("submit", "submit"), o)
        assert d.decision == "confirm" and "submit-verb" in d.rules_fired

    def test_otp_field_still_forces_confirm(self):
        """Defense in depth: even if something tried to automate the OTP step,
        the policy layer refuses to let it through unattended."""
        o = obs(elements=[
            InteractiveElement(eid="e1", nid="deadbeef", role="textbox",
                               name="One-time code", input_type="text",
                               is_editable=True, box=[0, 0, 100, 30]),
        ])
        d = evaluate(act("type", "e1", text="123456"), o)
        assert d.decision == "confirm"
        assert "requires-live-human" in d.rules_fired

    def test_confirmation_preview_names_who_is_absent(self):
        o = _roster_observation()
        action = ActionProposal.model_validate({
            "action": "click", "reason": "submit the roster",
            "target": {"element_id": "submit", "name": "Submit Attendance"},
        })
        preview = redact_preview(action, o)
        assert "Gaurav Kumar" in preview
        assert "Nikhil Sharma" in preview
        assert "2 checked, 2 unchecked" in preview

    def test_preview_falls_back_without_an_observation(self):
        action = ActionProposal.model_validate({
            "action": "click", "reason": "submit the roster",
            "target": {"element_id": "submit", "name": "Submit Attendance"},
        })
        assert redact_preview(action, None) == "click Submit Attendance"
