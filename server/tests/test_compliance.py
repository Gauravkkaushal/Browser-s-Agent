"""Tests for the DPDP Act 2023 compliance report.

The report is only ever as honest as the audit trail it reads, so these tests
build a real audit file with the actual hash-chaining code in server.events
(`_append_audit`) rather than hand-rolling JSON lines -- the same function
the live pipeline calls on every event -- then check that
`compliance.generate_report` aggregates it correctly and that tampering with
the file is actually detected, not just assumed.
"""
from __future__ import annotations

import json

import pytest

from server import compliance, events


@pytest.fixture(autouse=True)
def isolate_audit_dir(tmp_path, monkeypatch):
    """Every test gets its own empty audit directory so runs cannot bleed
    into each other or the developer's real ~/.browser-agent tasks."""
    monkeypatch.setattr(events, "AUDIT_DIR", tmp_path)
    yield tmp_path


def _write(task_id: str, type_: str, payload: dict, step: int = 1) -> None:
    env = {
        "v": 1, "type": type_, "ts": "2026-01-01T00:00:00Z",
        "task_id": task_id, "step": step, "seq": step, "payload": payload,
    }
    events._append_audit(task_id, env)


def _seed_task(task_id: str) -> None:
    _write(task_id, "OBSERVATION_RECEIVED", {"url": "https://example.com/", "qr_detected": 1}, step=1)
    _write(task_id, "MASKING_APPLIED", {
        "pii_redactions": {"EMAIL": 2, "CARD": 1},
        "pii_verified": {"CARD": 1},
        "injections_neutralized": 1,
    }, step=1)
    _write(task_id, "OBSERVATION_RECEIVED", {"url": "https://example.com/form", "qr_detected": 0}, step=2)
    _write(task_id, "MASKING_APPLIED", {
        "pii_redactions": {"EMAIL": 1, "PHONE": 3},
        "pii_verified": {},
        "injections_neutralized": 0,
    }, step=2)
    _write(task_id, "POLICY_DENIED", {"action": "click", "decision": {"reason": "blocked"}}, step=2)
    _write(task_id, "CONFIRMATION_REQUESTED", {"action": "click"}, step=3)
    _write(task_id, "CONFIRMATION_GRANTED", {"action": "click"}, step=3)


class TestGenerateReport:
    def test_no_audit_file_is_reported_as_not_found(self):
        report = compliance.generate_report("task-does-not-exist")
        assert report == {"task_id": "task-does-not-exist", "found": False}

    def test_aggregates_real_numbers_across_steps(self):
        _seed_task("task-a")
        report = compliance.generate_report("task-a")
        assert report["found"] is True
        assert report["steps"] == 2  # two OBSERVATION_RECEIVED events

        minim = next(p for p in report["principles"] if p["id"] == "minimization")
        assert minim["status"] == "implemented"
        assert minim["evidence"]["redacted_by_type"] == {"EMAIL": 3, "CARD": 1, "PHONE": 3}
        assert minim["evidence"]["pii_items_redacted_before_leaving_device"] == 7
        assert minim["evidence"]["qr_codes_masked"] == 1
        assert minim["evidence"]["prompt_injection_attempts_neutralized"] == 1

        security = next(p for p in report["principles"] if p["id"] == "security-safeguards")
        assert security["evidence"]["checksum_verified_by_type"] == {"CARD": 1}
        assert security["evidence"]["checksum_verified_total"] == 1
        assert security["evidence"]["fail_closed_catches"] == 0

        consent = next(p for p in report["principles"] if p["id"] == "consent-human-in-loop")
        assert consent["evidence"]["actions_denied_by_policy"] == 1
        assert consent["evidence"]["actions_requiring_live_confirmation"] == 1
        assert consent["evidence"]["confirmations_granted"] == 1

    def test_redaction_verify_failure_is_counted_not_hidden(self):
        """A caught leak is the safeguard working, not a bug -- the report
        has to surface it honestly either way."""
        _write("task-b", "OBSERVATION_RECEIVED", {"url": "https://example.com/"}, step=1)
        _write("task-b", "MASKING_APPLIED", {"pii_redactions": {"CARD": 1}, "pii_verified": {"CARD": 1}}, step=1)
        _write("task-b", "REDACTION_VERIFY_FAILED", {"kinds": ["CARD"]}, step=1)

        report = compliance.generate_report("task-b")
        security = next(p for p in report["principles"] if p["id"] == "security-safeguards")
        assert security["evidence"]["fail_closed_catches"] == 1
        assert security["evidence"]["leaked_kinds_caught_and_withheld"] == ["CARD"]

    def test_storage_limitation_is_always_reported_as_a_real_gap(self):
        """No amount of good data should make this claim something it isn't --
        there is genuinely no retention/erasure control in the codebase yet."""
        _seed_task("task-c")
        report = compliance.generate_report("task-c")
        storage = next(p for p in report["principles"] if p["id"] == "storage-limitation")
        assert storage["status"] == "not implemented"

    def test_accountability_reflects_real_chain_integrity(self):
        _seed_task("task-d")
        report = compliance.generate_report("task-d")
        acc = next(p for p in report["principles"] if p["id"] == "accountability")
        assert acc["status"] == "implemented"
        assert acc["evidence"]["audit_chain_verified"] is True
        assert acc["evidence"]["audit_lines"] == 7

    def test_tampered_audit_file_is_caught_not_trusted(self, tmp_path):
        _seed_task("task-e")
        path = tmp_path / "task-e.jsonl"
        lines = path.read_text(encoding="utf-8").splitlines()
        # Flip a real number in an early line without recomputing any hash --
        # exactly what a tamper attempt would do.
        tampered = json.loads(lines[1])
        tampered["payload"]["pii_redactions"]["EMAIL"] = 999
        lines[1] = json.dumps(tampered)
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")

        report = compliance.generate_report("task-e")
        acc = next(p for p in report["principles"] if p["id"] == "accountability")
        assert acc["status"] == "integrity check failed"
        assert acc["evidence"]["audit_chain_verified"] is False


class TestRenderHtml:
    def test_not_found_renders_a_clear_message(self):
        html = compliance.render_html({"task_id": "ghost", "found": False})
        assert "No audit trail yet" in html
        assert "ghost" in html

    def test_found_report_renders_real_numbers_and_disclaimer(self):
        _seed_task("task-f")
        report = compliance.generate_report("task-f")
        html = compliance.render_html(report)
        assert html.startswith("<!doctype html>")
        assert "task-f" in html
        assert "DPDP Act 2023" in html
        assert "not a legal compliance certificate" in html
        assert "Storage limitation" in html
        # Real counts should be visible in the rendered evidence, not just held in the dict.
        assert "7" in html  # pii_items_redacted_before_leaving_device

    def test_html_escapes_hostile_task_id(self):
        """task_id ends up in the page verbatim from a URL path segment --
        it must never be interpretable as markup."""
        report = {"task_id": "<script>alert(1)</script>", "found": False}
        html = compliance.render_html(report)
        assert "<script>alert(1)</script>" not in html
        assert "&lt;script&gt;" in html
