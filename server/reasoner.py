"""REASONER role: one observation in, exactly one ActionProposal out.

The model never touches the browser. It picks an element id from the observation
it was shown and names a verb; the server validates that against the schema,
re-grounds the target from the live observation (so the model's chosen id is
backed by real nid/name/path fallbacks), and only then hands it to the policy
layer.

Invalid JSON gets exactly one corrective retry, then the step fails honestly.
"""
from __future__ import annotations

import json
import uuid
from typing import Any, Dict, List, Optional

from pydantic import ValidationError

from . import llm
from .knowledge import hints_for
from .schemas import ActionProposal, Observation, Plan

SYSTEM = """You drive a real Chrome browser, one action at a time.

You are given: the user's objective, the plan, what has already happened, and a
fresh observation of the page as it is RIGHT NOW. You reply with exactly ONE
next action as JSON.

GROUNDING
- You may only target elements by the `eid` values present in this observation.
- Never invent an eid. Never use CSS selectors, XPath, or pixel coordinates.
- If the element you need is not listed, scroll or navigate to reveal it first.

VERBS
navigate(params.url)          open a URL in the current tab
open_tab(params.url)          open a new tab (use for comparing two sites)
switch_tab(target.tab_id)     focus an existing tab
close_tab(target.tab_id)      only tabs the agent opened
back / forward                history
click(target.element_id)      click a real element
type(target.element_id, params.text)   set a field's text (works on
                              contenteditable composers too)
keypress(params.key_combo)    "Enter", "Escape", "ctrl+k", ...
scroll(params.direction, params.amount_px)
hover / focus(target.element_id)
select(target.element_id, params.value)   a <select> option
wait(params.timeout_ms, params.text_contains)   wait for text to appear
extract(params.max_results)   read a repeated list of priced items off the page
screenshot                    capture the current view
submit(target.element_id)     submit a form (always needs human approval)
finish(params.summary)        the objective is achieved; summarise the ANSWER
fail(params.error)            you are genuinely blocked; say exactly why

EXPECTATIONS -- REQUIRED
Every non-terminal action must carry params.expected describing the observable
change you predict, using one or more of: url_contains, text_contains,
element_appears, element_gone. The system checks this against the next real
observation. Predict what will actually be true, not what you hope.

DISCIPLINE
- One action. The smallest next step that makes real progress.
- If page_state.overlay_present is true, deal with the overlay first.
- If page_state.login_wall is set, do NOT try to sign in and do NOT type
  credentials. Emit wait; the system handles the human sign-in.
- Do not repeat an action that just failed; try a different route.
- Actions that send, buy, pay, post or delete will be paused for human
  approval. Propose them normally when the task calls for them.
- Only call finish when the objective is genuinely met, and put the actual
  answer in params.summary (prices, the message sent, what you found).

Return JSON exactly:
{"action": "<verb>",
 "target": {"element_id": "e12" or null, "tab_id": null},
 "params": {...only the fields that verb needs...,
            "expected": {"url_contains": "..."}},
 "reason": "why this action, in one sentence",
 "confidence": 0.0-1.0}"""


def _compact_elements(obs: Observation, limit: int = 110) -> List[Dict[str, Any]]:
    """Trim the observation to what the model needs to choose an element."""
    rows: List[Dict[str, Any]] = []
    # Elements in the viewport are far more likely to be actionable.
    ordered = sorted(obs.interactive_elements, key=lambda e: (not e.in_viewport, e.box[1] if e.box else 0))
    for el in ordered[:limit]:
        row: Dict[str, Any] = {"eid": el.eid, "role": el.role}
        if el.name:
            row["name"] = el.name[:90]
        if el.text and el.text[:90] != el.name[:90]:
            row["text"] = el.text[:90]
        if el.is_editable:
            row["editable"] = True
            if el.value:
                row["value"] = el.value[:60]
        if el.input_type:
            row["input_type"] = el.input_type
        if el.href:
            row["href"] = el.href[:110]
        if not el.in_viewport:
            row["offscreen"] = True
        if el.is_protected:
            row["protected"] = True
        rows.append(row)
    return rows


def _observation_digest(obs: Observation) -> Dict[str, Any]:
    return {
        "url": obs.url,
        "title": obs.title,
        "scroll": obs.scroll,
        "page_state": {
            "loading": obs.page_state.loading,
            "overlay_present": obs.page_state.overlay_present,
            "login_wall": obs.page_state.login_wall.model_dump() if obs.page_state.login_wall else None,
        },
        "tabs": [{"tab_id": t.tab_id, "url": t.url[:90], "active": t.active,
                  "agent_owned": t.agent_owned} for t in obs.tabs],
        "interactive_count": len(obs.interactive_elements),
        "elements": _compact_elements(obs),
        "focused_element": obs.focused_element,
        "errors": obs.errors,
    }


def _history_lines(history: List[Dict[str, Any]], limit: int = 12) -> str:
    if not history:
        return "(nothing yet -- this is the first action)"
    out = []
    for h in history[-limit:]:
        line = "step %s: %s" % (h.get("step"), h.get("summary"))
        if h.get("verdict"):
            line += " -> " + h["verdict"]
        if h.get("detail"):
            line += " (" + str(h["detail"])[:180] + ")"
        out.append(line)
    return "\n".join(out)


def _ground(action: ActionProposal, obs: Observation) -> ActionProposal:
    """Attach real grounding fallbacks from the live observation.

    The model only ever gives us an eid. The nid, accessible name and css path
    come from the observation itself, so the executor has three ways to find the
    element again if the page has moved on.
    """
    if action.target.element_id:
        el = obs.element(action.target.element_id)
        if el is not None:
            action.target.nid = el.nid
            action.target.name = el.name or el.text
            action.target.path = el.path
    if not action.action_id:
        action.action_id = "act_" + uuid.uuid4().hex[:10]
    return action


async def propose(
    objective: str,
    plan: Plan,
    obs: Observation,
    history: List[Dict[str, Any]],
    task_id: str,
    step: int,
    extracted: Optional[List[Dict[str, Any]]] = None,
) -> ActionProposal:
    plan_text = "\n".join(
        "%d. %s (done when: %s)" % (s.n, s.goal, s.done_when or "n/a") for s in plan.steps
    )
    payload = {
        "objective": objective,
        "plan": plan_text,
        "steps_taken_so_far": _history_lines(history),
        "data_gathered": (extracted or [])[:40],
        "site_hints": hints_for(obs.url),
        "observation": _observation_digest(obs),
        "budget": {"step": step, "note": "be efficient; do not loop"},
    }
    user = json.dumps(payload, ensure_ascii=False, indent=1)

    raw = await llm.call("reasoner", SYSTEM, user, task_id=task_id, step=step)
    try:
        action = ActionProposal.model_validate(raw)
    except ValidationError as exc:
        # Exactly one corrective retry, quoting the real validation error.
        retry_user = (
            user
            + "\n\nYour previous reply was rejected by the schema validator:\n"
            + str(exc)[:900]
            + "\n\nReturn ONE corrected JSON action. Use only allowed verbs and an eid "
              "that appears in the observation above."
        )
        raw2 = await llm.call("reasoner", SYSTEM, retry_user, task_id=task_id, step=step)
        action = ActionProposal.model_validate(raw2)

    return _ground(action, obs)
