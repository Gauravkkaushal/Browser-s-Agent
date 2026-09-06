"""PII redaction for text that never passed through the page walker.

Normally redaction happens in the page, before an observation is serialised, so
sensitive values never leave the machine at all. That is the right place for it
and nothing here replaces it.

This module exists for the one case the walker cannot cover: a page Chrome will
not let a content script touch (chrome://, the Web Store, its own PDF viewer).
There the only way to read the screen is to look at it, and whatever a vision
model transcribes arrives here as plain text with nothing redacted yet. Cleaning
it at this point does not undo the image having been sent -- nothing can -- but
it keeps the values out of notes, messages, the audit log and every later prompt.

The pattern TYPES are kept in step with public/agent-content.js by a test, so
the two cannot quietly drift apart.
"""
from __future__ import annotations

import re
from typing import Dict, List, Tuple

PATTERNS: List[Tuple[str, re.Pattern]] = [
    ("CARD", re.compile(r"\b(?:\d[ -]*?){13,19}\b")),
    ("AADHAAR", re.compile(r"\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b(?!\s?\d)")),
    ("PAN", re.compile(r"\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b")),
    ("GSTIN", re.compile(r"\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}\b")),
    ("VOTERID", re.compile(r"\b[A-Z]{3}[0-9]{7}\b")),
    ("DL", re.compile(r"\b[A-Z]{2}[0-9]{2}[ -]?(?:19|20)[0-9]{2}[0-9]{7}\b")),
    ("UPI", re.compile(r"\b[\w.-]+@(?:upi|oksbi|okhdfcbank|okaxis|paytm|ibl|ybl|apl)\b", re.I)),
    ("EMAIL", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    # Real numbers are written with spaces and hyphens: "+91 95577 00749" is how
    # a phone book, a chat header and a group member list all render one. An
    # earlier version demanded ten unbroken digits and so missed the commonest
    # form there is -- a privacy tool leaking the exact thing it exists to hide.
    ("PHONE", re.compile(r"(?:\+?91[\s-]?)?[6-9](?:[\s-]?\d){9}(?!\d)")),
]


def redact_text(text: str) -> Tuple[str, Dict[str, int]]:
    """Return the text with values replaced, and a count per kind."""
    if not text:
        return "", {}
    counts: Dict[str, int] = {}
    out = text
    for kind, pattern in PATTERNS:
        def swap(_match: re.Match, _kind: str = kind) -> str:
            counts[_kind] = counts.get(_kind, 0) + 1
            return "[REDACTED:%s]" % _kind

        out = pattern.sub(swap, out)
    return out, counts
