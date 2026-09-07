"""Trust-boundary masking: page content becomes DATA before a model sees it.

The PII half of masking happens earlier, in the page itself: the walker replaces
every phone number, card, email and so on with `[REDACTED:TYPE]` before the
observation is ever serialised, so the values never leave the machine at all.
This module handles the other half -- text on the page that is shaped like an
*instruction to the agent*.

Grounded in:
  - Willison, "The Lethal Trifecta" (2025): private data + untrusted content +
    the ability to send = separate by construction, not by asking nicely.
  - Microsoft Spotlighting (arXiv 2503.18879): marking untrusted spans measurably
    lowers injection success.
  - DeepMind CaMeL (arXiv 2503.18813): the hard boundary is provenance enforced
    in code, which lives next door in capability_gate.py. Everything here only
    *reduces* injection pressure; it is not the guarantee.

TWO RULES THIS FILE EXISTS TO OBEY
1. Never corrupt what the agent must echo back. An earlier version datamarked
   element names and values too. The reasoner picks elements by name, predicts
   `text_contains` from them and the verifier checks those predictions against
   the REAL observation -- so marked-up names meant every prediction missed,
   every action looked failed, and the agent retried forever. Element fields are
   already PII-redacted by the walker; they are left exactly as they are.
2. Never blind the agent to do it. An earlier version replaced a whole line if
   it contained the bare word "ai", "system" or "agent" -- and on the many pages
   whose text is one long line, that deleted the entire page. Neutralisation is
   per-sentence and only for genuinely injection-shaped spans.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Tuple

from .schemas import Observation

# --- Text that is trying to give the agent orders ---------------------------
#
# Every pattern here has to be something no ordinary page says by accident.
# "system", "agent" and "ai" appear constantly in normal copy, so they are not
# on this list; the cost of a false positive is the agent going blind.
INJECTION_PATTERNS: List[Tuple[str, re.Pattern]] = [
    ("override", re.compile(
        r"(ignore|disregard|forget)\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|"
        r"foregoing)\s*(instructions?|prompts?|rules?|context)?", re.I)),
    ("new-orders", re.compile(
        r"(your\s+(new\s+)?(task|instruction|objective|goal|job)\s+is\b"
        r"|new\s+(task|instructions?)\s*[:\-]"
        r"|from\s+now\s+on\s+you\s+(must|will|should)\b"
        r"|you\s+are\s+now\s+(a|an|the)\b)", re.I)),
    ("prompt-theft", re.compile(
        r"(reveal|repeat|print|output|show|disclose)\s+(me\s+)?(your|the)\s+"
        r"(system\s+)?(prompt|instructions?|rules?|configuration)", re.I)),
    ("credential-lure", re.compile(
        r"((send|share|post|email|paste|forward|upload)\s+(me\s+)?(your|the|all)\s+"
        r"(password|credential|api[\s_-]?key|token|secret|cookie|session|otp)"
        r"|exfiltrate)", re.I)),
    ("addressed-to-the-agent", re.compile(
        r"^\s*(hey\s+)?(ai|agent|assistant|bot|claude|chatgpt|gemini|copilot)\s*[,:]\s*\S", re.I)),
]

# A sentence, roughly. Page text has no reliable punctuation, so newlines count.
_SENTENCE = re.compile(r"[^.!?\n]+[.!?\n]?")

# One marker per this many words. Spotlighting's evidence is for interleaved
# markers; the interval is a cost knob. Every three words -- what this file used
# to do -- inflates the single largest field in the prompt by a third, which is
# paid on every step of every task, forever. Every twelve keeps the signal that
# the block is data while costing almost nothing.
DATAMARK_EVERY = 12

PAGE_TEXT_CAP = 4000


def neutralize_instructions(text: str) -> Tuple[str, List[Dict[str, str]]]:
    """Replace injection-shaped sentences. Returns the text and what was hit."""
    if not text:
        return "", []
    found: List[Dict[str, str]] = []

    def scrub(match: re.Match) -> str:
        sentence = match.group(0)
        for label, pattern in INJECTION_PATTERNS:
            if pattern.search(sentence):
                found.append({"kind": label, "text": sentence.strip()[:160]})
                # Keep the trailing newline so the page's shape survives.
                tail = "\n" if sentence.endswith("\n") else ""
                return "[NEUTRALIZED:%s]%s" % (label.upper(), tail)
        return sentence

    return _SENTENCE.sub(scrub, text), found


def datamark(text: str) -> str:
    """Interleave markers so the block reads as opaque data, not prose."""
    if not text:
        return ""
    words = text.split()
    out: List[str] = []
    for i, word in enumerate(words, start=1):
        out.append(word)
        if i % DATAMARK_EVERY == 0:
            out.append("·%d·" % (i // DATAMARK_EVERY))
    return " ".join(out)


def sanitize_observation(obs: Observation) -> Tuple[Observation, Dict[str, Any]]:
    """Return a reasoner-safe view of `obs`, plus a report of what was masked.

    Mutates and returns the object it is given, so callers MUST hand it a copy:
    the loop, the verifier and the executor all need the untouched original to
    match elements and judge whether an action worked.
    """
    original_text = obs.page_text or ""
    neutralized, injections = neutralize_instructions(original_text)
    obs.page_text = datamark(neutralized)[:PAGE_TEXT_CAP]

    # Element name/text/value are deliberately untouched. See rule 1 above.

    report = {
        # What the walker hid inside the page, before anything was serialised.
        "pii_redactions": dict(obs.pii_redactions or {}),
        "pii_total": sum(int(v or 0) for v in (obs.pii_redactions or {}).values()),
        "pii_occurrences": dict(obs.pii_occurrences or {}),
        "masked_regions": len(obs.sensitive_boxes or []),
        # What each box covers, so "5 regions blacked out" can be checked
        # rather than taken on faith.
        "regions": (obs.masked_regions or [])[:12],
        # What this module neutralised on the way to the model.
        "injections_neutralized": len(injections),
        "injections": injections[:8],
        "page_text_chars": len(obs.page_text),
        "datamarked": bool(obs.page_text),
        # The actual opening of what the model is about to read. This is the
        # only claim in the report that survives an audit -- counters can drift;
        # the [REDACTED:...] placeholders in it ARE the masking, visible in the
        # exact bytes that leave the machine.
        "llm_input_sample": obs.page_text[:400],
    }
    return obs, report
