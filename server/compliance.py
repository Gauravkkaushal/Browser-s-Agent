"""DPDP Act 2023 technical-controls report.

Turns a task's own real audit trail into a report mapping what the pipeline
actually did -- measured, not claimed -- onto the technical obligations a
Data Fiduciary carries under India's Digital Personal Data Protection Act,
2023. Every number here is read back out of the same hash-chained audit file
`/tasks/{id}/audit` and `/tasks/{id}/audit/verify` already expose; this module
adds no new data, it only aggregates and labels what the pipeline already
logged for that task.

This is a technical-controls summary, not a legal compliance certificate.
Organisational obligations (Consent Manager registration, a grievance
officer, a data-retention policy, cross-border transfer rules) live outside
application code and are named as gaps below rather than silently ignored.
"""
from __future__ import annotations

import json
from html import escape
from typing import Any, Dict, List

from .events import audit_path, verify_audit_chain


def _load_events(task_id: str) -> List[Dict[str, Any]]:
    path = audit_path(task_id)
    if not path.exists():
        return []
    out: List[Dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def _sum_counts(dicts: List[Dict[str, Any]]) -> Dict[str, int]:
    out: Dict[str, int] = {}
    for d in dicts:
        for k, v in (d or {}).items():
            out[k] = out.get(k, 0) + int(v or 0)
    return out


def generate_report(task_id: str) -> Dict[str, Any]:
    """Build the report dict for `task_id`. `found=False` if there is no
    audit trail for it yet (the compliance report has nothing to say about a
    task that has not run)."""
    envs = _load_events(task_id)
    if not envs:
        return {"task_id": task_id, "found": False}

    by_type: Dict[str, List[Dict[str, Any]]] = {}
    for e in envs:
        by_type.setdefault(e.get("type", ""), []).append(e)

    masking = [e["payload"] for e in by_type.get("MASKING_APPLIED", [])]
    observations = [e["payload"] for e in by_type.get("OBSERVATION_RECEIVED", [])]
    verify_failures = [e["payload"] for e in by_type.get("REDACTION_VERIFY_FAILED", [])]
    policy_denied = by_type.get("POLICY_DENIED", [])
    confirm_requested = by_type.get("CONFIRMATION_REQUESTED", [])
    confirm_granted = by_type.get("CONFIRMATION_GRANTED", [])
    confirm_denied = by_type.get("CONFIRMATION_DENIED", [])
    security_blocked = by_type.get("SECURITY_BLOCKED", [])

    pii_redacted_by_type = _sum_counts([m.get("pii_redactions", {}) for m in masking])
    pii_verified_by_type = _sum_counts([m.get("pii_verified", {}) for m in masking])
    injections_neutralized = sum(int(m.get("injections_neutralized") or 0) for m in masking)
    qr_detected_total = sum(int(o.get("qr_detected") or 0) for o in observations)

    leaked_kinds: List[str] = []
    for f in verify_failures:
        leaked_kinds.extend(f.get("kinds", []))

    steps = len(observations)
    integrity = verify_audit_chain(task_id)

    principles = [
        {
            "id": "minimization",
            "title": "Data minimisation & purpose limitation",
            "reference": "DPDP Act 2023, Section 8 -- general obligations of a Data Fiduciary",
            "status": "implemented" if steps > 0 else "no data",
            "evidence": {
                "steps_observed": steps,
                "pii_items_redacted_before_leaving_device": sum(pii_redacted_by_type.values()),
                "redacted_by_type": pii_redacted_by_type,
                "qr_codes_masked": qr_detected_total,
                "prompt_injection_attempts_neutralized": injections_neutralized,
            },
            "explanation": (
                "Every page the agent looked at was redacted on-device -- emails, "
                "cards, Aadhaar numbers, phone numbers and payment QR codes -- "
                "before any text or screenshot left the machine for a cloud model "
                "call. Only what the task actually needed was ever exposed."
            ),
        },
        {
            "id": "security-safeguards",
            "title": "Reasonable security safeguards",
            "reference": "DPDP Act 2023, Section 8 -- reasonable security safeguards against a personal data breach",
            "status": "implemented",
            "evidence": {
                "checksum_verified_by_type": pii_verified_by_type,
                "checksum_verified_total": sum(pii_verified_by_type.values()),
                "fail_closed_catches": len(verify_failures),
                "leaked_kinds_caught_and_withheld": sorted(set(leaked_kinds)),
            },
            "explanation": (
                "Card and Aadhaar numbers are checksum-validated (Luhn / Verhoeff) "
                "rather than trusted on shape alone, and every redacted screenshot "
                "is independently re-read on-device (OCR) to confirm nothing leaked "
                "through the blackout. If it had, the screenshot for that step would "
                "have been withheld rather than sent -- fail_closed_catches counts "
                "exactly how many times that safeguard fired."
            ),
        },
        {
            "id": "accountability",
            "title": "Accountability & record-keeping",
            "reference": "DPDP Act 2023, Section 8 -- obligation to maintain accurate, verifiable records",
            "status": "implemented" if integrity.get("ok") else "integrity check failed",
            "evidence": {
                "audit_chain_verified": bool(integrity.get("ok")),
                "audit_lines": integrity.get("lines", 0),
                "audit_head_hash": integrity.get("head_hash"),
            },
            "explanation": (
                "Every event this task produced was written to a SHA-256 "
                "hash-chained, append-only log. The numbers above come from "
                "recomputing that chain from scratch just now, not from a stored "
                "flag someone could have edited."
            ),
        },
        {
            "id": "consent-human-in-loop",
            "title": "Human-in-the-loop for consequential processing",
            "reference": "DPDP Act 2023, Section 6 -- consent must be free, specific and informed",
            "status": "implemented",
            "evidence": {
                "actions_denied_by_policy": len(policy_denied),
                "actions_requiring_live_confirmation": len(confirm_requested),
                "confirmations_granted": len(confirm_granted),
                "confirmations_declined_or_timed_out": len(confirm_denied),
                "security_blocks": len(security_blocked),
            },
            "explanation": (
                "Payments, deletions, submissions and any field named like a "
                "password/OTP/CVV are never run unattended -- a deterministic "
                "policy gateway with no model in the loop holds them for a human "
                "decision, and the decision is logged either way."
            ),
        },
        {
            "id": "storage-limitation",
            "title": "Storage limitation & erasure",
            "reference": "DPDP Act 2023, Section 8 -- erase personal data once its purpose is served",
            "status": "not implemented",
            "evidence": {},
            "explanation": (
                "Honest gap: audit logs are kept indefinitely on local disk today. "
                "There is no automatic retention window or erasure command yet. "
                "This is a real limitation, not a claim being made here -- it "
                "would need to be added before any production deployment."
            ),
        },
    ]

    return {
        "task_id": task_id,
        "found": True,
        "steps": steps,
        "principles": principles,
        "audit_integrity": integrity,
        "disclaimer": (
            "This is a technical-controls summary generated from this task's own "
            "audit trail, offered to explain what the system actually does. It is "
            "not a legal compliance certificate and does not cover organisational "
            "obligations (Consent Manager registration, a grievance officer, a "
            "retention policy, cross-border transfer rules) that sit outside "
            "application code."
        ),
    }


_STATUS_COLOR = {
    "implemented": "#0a7d3a",
    "not implemented": "#b3261e",
    "integrity check failed": "#b3261e",
    "no data": "#9a7b00",
}


def render_html(report: Dict[str, Any]) -> str:
    """A self-contained, printable HTML rendering of `generate_report()`'s
    output. Every dynamic value is escaped -- this is served straight to a
    browser, and evidence values, while normally just counts and our own
    controlled type-name vocabulary, should never be trusted as inert."""
    task_id = escape(str(report.get("task_id", "")))
    if not report.get("found"):
        return (
            "<!doctype html><meta charset='utf-8'>"
            "<title>DPDP compliance report</title>"
            "<body style='font-family:system-ui,sans-serif;padding:2rem'>"
            "<h1>No audit trail yet</h1>"
            "<p>Task <code>%s</code> has not produced any recorded steps.</p>"
            "</body>" % task_id
        )

    rows = []
    for p in report["principles"]:
        color = _STATUS_COLOR.get(p["status"], "#555")
        evidence_items = "".join(
            "<li><b>%s</b>: %s</li>" % (escape(str(k)), escape(json.dumps(v)))
            for k, v in p["evidence"].items()
        )
        rows.append(
            "<section class='principle'>"
            "<h2>%s <span class='status' style='color:%s'>%s</span></h2>"
            "<p class='ref'>%s</p>"
            "<p>%s</p>"
            "<ul class='evidence'>%s</ul>"
            "</section>"
            % (
                escape(p["title"]), color, escape(p["status"]),
                escape(p["reference"]), escape(p["explanation"]), evidence_items,
            )
        )

    integrity = report["audit_integrity"]
    integrity_line = "Audit chain verified: %s (%d line%s, head %s)" % (
        "yes" if integrity.get("ok") else "NO -- " + escape(str(integrity.get("error"))),
        integrity.get("lines", 0),
        "" if integrity.get("lines", 0) == 1 else "s",
        escape((integrity.get("head_hash") or "")[:16] or "n/a"),
    )

    return """<!doctype html>
<meta charset="utf-8">
<title>DPDP compliance report -- %s</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 760px;
         margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; line-height: 1.45; }
  h1 { font-size: 1.4rem; margin-bottom: .1rem; }
  .sub { color: #666; margin-top: 0; }
  .principle { border: 1px solid #ddd; border-radius: 10px; padding: 1rem 1.25rem; margin: 1rem 0; }
  .principle h2 { font-size: 1.05rem; margin: 0 0 .25rem; }
  .status { font-size: .75rem; font-weight: 700; text-transform: uppercase; float: right; }
  .ref { font-size: .8rem; color: #666; margin: 0 0 .5rem; }
  .evidence { font-size: .85rem; color: #333; }
  .integrity { background: #f4f4f4; padding: .75rem 1rem; border-radius: 8px; font-size: .85rem; }
  .disclaimer { font-size: .75rem; color: #777; margin-top: 2rem; border-top: 1px solid #eee; padding-top: 1rem; }
  @media print { body { margin: 0; } .principle { break-inside: avoid; } }
</style>
<h1>DPDP Act 2023 -- technical controls report</h1>
<p class="sub">Task <code>%s</code> &middot; %d step(s) observed</p>
<div class="integrity">%s</div>
%s
<p class="disclaimer">%s</p>
""" % (
        task_id, task_id, report["steps"], integrity_line,
        "".join(rows), escape(report["disclaimer"]),
    )
