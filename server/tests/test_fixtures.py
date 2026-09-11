"""Tests that the /fixtures/govt-scholarship demo page actually behaves the
way its on-page copy claims -- the fixture exists to be shown to judges as
proof the pipeline works on government-shaped data, so a claim on the page
that policy.evaluate() does not actually honour would be worse than no demo
at all.
"""
from __future__ import annotations

from server.policy import evaluate
from server.schemas import ActionProposal, InteractiveElement, Observation


def test_govt_scholarship_fixture_is_served():
    from fastapi.testclient import TestClient
    from server.main import app

    client = TestClient(app)
    r = client.get("/fixtures/govt-scholarship")
    assert r.status_code == 200
    assert "Rashtriya Chhatra Sahayata Portal" in r.text
    # Never impersonates a real government domain/site.
    assert "not affiliated with" in r.text.lower()


def test_confirm_and_submit_button_is_held_for_a_human():
    """The button the fixture calls out as consequential must actually be
    classified HIGH and routed to 'confirm', not just described as such."""
    obs = Observation(
        url="http://127.0.0.1:8787/fixtures/govt-scholarship",
        title="Rashtriya Chhatra Sahayata Portal",
        interactive_elements=[
            InteractiveElement(eid="e1", role="button",
                                name="Confirm & Submit Application"),
        ],
    )
    action = ActionProposal.model_validate({
        "action": "click", "reason": "submit the completed application",
        "target": {"element_id": "e1"},
    })
    decision = evaluate(action, obs)
    assert decision.decision == "confirm"
    assert any(r.startswith("high-risk-control-name") for r in decision.rules_fired)


def test_aadhaar_demo_value_is_genuinely_checksum_valid():
    """The Aadhaar number printed on the fixture is claimed to be
    'checksum-verifiable' -- it has to actually pass Verhoeff, not just look
    like 12 digits, or the compliance report's checksum_verified_total would
    have nothing real to count for this demo."""
    import re
    from pathlib import Path

    html = Path(__file__).parent.parent / "fixtures" / "govt_scholarship.html"
    text = html.read_text(encoding="utf-8")
    m = re.search(r'id="aadhaar"[^>]*value="([\d ]+)"', text)
    assert m, "fixture must carry an aadhaar input value"
    digits = m.group(1).replace(" ", "")
    assert len(digits) == 12

    # Verhoeff validation, mirrored from public/agent-content.js's
    # verhoeffValid() -- same tables, same algorithm, checked against the
    # actual value shipped in the fixture rather than assumed correct.
    d_table = [
        [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],
        [3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
        [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],
        [9,8,7,6,5,4,3,2,1,0],
    ]
    p_table = [
        [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],
        [8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
        [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8],
    ]
    c = 0
    for i, ch in enumerate(reversed(digits)):
        c = d_table[c][p_table[i % 8][int(ch)]]
    assert c == 0, "aadhaar demo value must be Verhoeff-valid (checksum digit 0)"
