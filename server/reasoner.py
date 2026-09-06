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
from .knowledge import GENERIC_HINTS, hints_for
from .vault import vault
from .schemas import ActionProposal, Observation, Plan

# How much page text to send per reasoning step. Enough to actually answer a
# question about the page -- an inbox or a results list is mostly text, and an
# agent starved of it will click around hunting for what it was already shown.
# Tiers 1 and 2 below shrink this automatically if a provider pushes back.
PAGE_TEXT_BUDGET = 5000

SYSTEM = """You drive a real Chrome browser, one action at a time.

You are given: the user's objective, the plan, what has already happened, and a
fresh observation of the page as it is RIGHT NOW. You reply with exactly ONE
next action as JSON.

GROUNDING
- Read `page_text` for information the user asked for (prices, copy, banners).
  Read `elements` for things you can act on. Both are part of the observation.
- You may only target elements by the `eid` values present in this observation.
- Never invent an eid. Never use CSS selectors, XPath, or pixel coordinates.
- If the element you need is not listed, scroll or navigate to reveal it first.

VERBS
navigate(params.url)          open a URL in the current tab
open_tab(params.url)          open a new tab (use for comparing two sites)
switch_tab(target.tab_id)     focus an existing tab. target.tab_id is REQUIRED --
                              take it from observation.tabs, never omit it
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
fill_credential(target.element_id, params.slot)
                              put a SAVED credential into a field. You name a
                              SLOT such as "lms.password" -- you never see, and
                              must never guess, the value. Only slots listed in
                              `available_credentials` exist, and each one only
                              works on the site it was registered for.
download(params.url)          download a file to the local downloads folder
list_downloads(params.filename_contains)
                              find recently downloaded files and their paths
upload_file(target.element_id, params.file_path)
                              attach a local file to an <input type="file">.
                              Use list_downloads first to learn the real path.
note(params.text)             record a fact you have just found, so it survives
                              the rest of the task. Use it the moment you read
                              the answer -- do not keep browsing and hope to
                              remember it later.
replan(params.discovered)     you have just READ what the task actually is, and
                              the current plan was written before anyone knew.
                              Describe the real request in full, in your own
                              words, and a fresh plan is written for it.
finish(params.summary)        the objective is achieved; summarise the ANSWER
fail(params.error)            you are genuinely blocked; say exactly why

EXPECTATIONS -- REQUIRED
Every non-terminal action must carry params.expected describing the observable
change you predict, using one or more of: url_contains, text_contains,
element_appears, element_gone.

Predict something that is FALSE NOW and will become TRUE. A prediction that is
already satisfied by the page in front of you proves nothing and is discarded --
for example, after clicking a conversation in a sidebar, do not predict that the
sidebar still shows its name. Predict what the NEW state will contain: the
message composer appearing, the header changing, a row disappearing.

WORKING IT OUT FOR YOURSELF
The command may be deliberately vague -- "do what he asked me to", "handle
what is in my inbox", "complete what is due". That means the real instruction
is written somewhere you have not read yet.

  1. Go and read it.
  2. The moment you know what is genuinely being asked, call `replan` and state
     that request in full. Do not carry on improvising against a placeholder
     plan, and do not press a button that merely sounds related.
  3. Then carry out the real task, and take yourself wherever it leads.

You are not confined to one site. If the request needs something you do not
have -- a written answer, a summary, a document, a piece of research -- go and
produce it: open a new tab, use a search engine or an AI assistant, wait for
the full reply, read it, then come back to the original tab (switch_tab) and
deliver it. Fetching what you need and returning with it is normal, expected
work, not a detour.

Before acting on any control, ask whether you actually have what it needs. An
attach or upload control is useless until a file exists; a send control is
useless until the message is written. Produce the thing first.

STOP LOOKING ONCE YOU HAVE IT
Check `page_text` and `elements` before hunting for a better source. Very often
the answer is already in front of you -- a table row, a heading, a paragraph --
and clicking around for an official-looking download link wastes the whole task.
If what you can already see answers the request, `note` it and move to the next
step. A summary you read off the page is a real answer; a link you never found
is not.

DISCIPLINE
- One action. The smallest next step that makes real progress.
- If page_state.overlay_present is true, deal with the overlay first.
- If page_state.login_wall is set: when `available_credentials` has a slot for
  this site, sign in with fill_credential (username, then password, then click
  the sign-in control). Otherwise do NOT try to sign in and do NOT invent
  credentials -- emit wait, and the system asks the human.
- NEVER put a password, code or secret in params.text. That is what
  fill_credential is for.
- Do not repeat an action that just failed. Anything listed under
  `already_tried_and_did_nothing` has been removed from `elements` on purpose --
  it did not work and is no longer available. Look for a DIFFERENT element.
- If you were trying to open something and it will not open, consider that it
  may already be open. Check `elements` for what the new state would contain --
  an editable textbox, a header, a different set of controls -- and carry on
  from there instead of trying to open it again.
- If you need to type but see no editable element, the composer may be below the
  fold or behind a click. Scroll, or open the thing that reveals it -- do not
  keep clicking what you already clicked.
- Actions that send, buy, pay, post or delete will be paused for human
  approval. Propose them normally when the task calls for them.
- Some tasks are answered by READING, not clicking: "what is in my inbox",
  "what does this cost", "what is due". If `page_text` already contains the
  answer, call finish immediately and put the ANSWER ITSELF in params.summary --
  quote the real senders, subjects, prices, dates you can see. Do not click
  around hunting for something you were already shown.
- If the page does NOT yet contain the answer, scroll or open the right item
  first. Never state a specific you cannot see: every concrete detail in your
  summary is checked against the observed page, and an unsupported answer is
  rejected.
- Only call finish when the objective is genuinely met, and put the actual
  answer in params.summary (prices, the message sent, what you found).

Return JSON exactly:
{"action": "<verb>",
 "target": {"element_id": "e12" or null, "tab_id": null},
 "params": {...only the fields that verb needs...,
            "expected": {"url_contains": "..."}},
 "reason": "why this action, in one sentence",
 "confidence": 0.0-1.0}"""


def _compact_elements(obs: Observation, limit: int = 45, name_cap: int = 60,
                      dead: Optional[Dict[str, str]] = None) -> List[Dict[str, Any]]:
    """Trim the observation to what the model needs to choose an element.

    Free model tiers meter tokens per minute, and a heavy application page can
    expose 200+ interactive nodes. Sending all of them costs a whole minute's
    budget for one step -- and pushes past the request size limit entirely. So
    prefer what is on screen, cap the list, and keep each row narrow.
    """
    rows: List[Dict[str, Any]] = []
    dead = dead or {}
    ordered = sorted(
        obs.interactive_elements,
        key=lambda e: (not e.in_viewport, e.box[1] if e.box else 0),
    )
    # Elements that have already been acted on repeatedly with no effect are
    # withheld. Naming them and asking nicely does not stop a model choosing
    # them again; taking them off the list does.
    ordered = [e for e in ordered if e.nid not in dead and e.eid not in dead]
    for el in ordered[:limit]:
        row: Dict[str, Any] = {"eid": el.eid, "role": el.role}
        if el.name:
            row["name"] = el.name[:name_cap]
        elif el.text:
            row["name"] = el.text[:name_cap]
        if el.is_editable:
            row["editable"] = True
            if el.value:
                row["value"] = el.value[:40]
        if el.input_type and el.input_type not in ("text", "button"):
            row["input_type"] = el.input_type
        if el.href:
            # The path is what distinguishes links; the query string rarely is.
            row["href"] = el.href.split("?")[0][:70]
        if not el.in_viewport:
            row["offscreen"] = True
        if el.is_protected:
            row["protected"] = True
        rows.append(row)
    return rows


def _observation_digest(obs: Observation, tier: int = 0,
                        dead: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Render the observation for the model at one of three sizes.

    tier 0 is the normal view. Tiers 1 and 2 are progressively leaner and are
    used to retry a call that the provider rejected as too large or that ran
    into a token-per-minute ceiling.
    """
    elements_cap = (70, 30, 15)[tier]
    name_cap = (60, 45, 35)[tier]
    text_cap = (PAGE_TEXT_BUDGET, 900, 0)[tier]

    digest: Dict[str, Any] = {
        "url": obs.url,
        "title": obs.title[:90],
        "page_state": {
            "loading": obs.page_state.loading,
            "overlay_present": obs.page_state.overlay_present,
            "login_wall": obs.page_state.login_wall.model_dump() if obs.page_state.login_wall else None,
        },
        "interactive_count": len(obs.interactive_elements),
        "elements": _compact_elements(obs, elements_cap, name_cap, dead),
    }
    if text_cap:
        # The readable text of the page. Answers to "what does it cost", "what
        # does it say", "did it confirm" live here, not among the buttons.
        digest["page_text"] = obs.page_text[:text_cap]
    if tier == 0:
        digest["scroll"] = obs.scroll
        digest["focused_element"] = obs.focused_element
        digest["tabs"] = [{"tab_id": t.tab_id, "url": t.url[:70], "active": t.active,
                           "agent_owned": t.agent_owned} for t in obs.tabs]
    if obs.errors:
        digest["errors"] = obs.errors[:3]
    return digest


def _history_lines(history: List[Dict[str, Any]], limit: int = 8) -> str:
    if not history:
        return "(nothing yet -- this is the first action)"
    out = []
    for h in history[-limit:]:
        line = "step %s: %s" % (h.get("step"), h.get("summary"))
        if h.get("verdict"):
            line += " -> " + h["verdict"]
        if h.get("detail"):
            line += " (" + str(h["detail"])[:110] + ")"
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
    discovered: str = "",
    notes: Optional[List[str]] = None,
    dead_targets: Optional[Dict[str, str]] = None,
) -> ActionProposal:
    plan_text = "\n".join(
        "%d. %s (done when: %s)" % (s.n, s.goal, s.done_when or "n/a") for s in plan.steps
    )

    def build(tier: int) -> str:
        payload: Dict[str, Any] = {
            "objective": objective,
            # Slot NAMES only. No value ever appears in a model prompt.
            "available_credentials": vault.describe(),
            "plan": plan_text,
            "steps_taken_so_far": _history_lines(history, 8 if tier == 0 else 4),
            "observation": _observation_digest(obs, tier, dead_targets),
            "budget": {"step": step, "note": "be efficient; do not loop"},
        }
        if discovered:
            # What the agent read for itself, and is now working towards.
            payload["the_real_request"] = discovered[:1200]
        if dead_targets:
            payload["already_tried_and_did_nothing"] = sorted(
                {v for v in dead_targets.values() if v})[:6]
        if notes:
            # Facts already gathered. These are yours -- use them rather than
            # going back to look for them again.
            payload["what_you_have_found_so_far"] = notes[-8:]
        if extracted:
            payload["data_gathered"] = extracted[:25 if tier == 0 else 8]
        hints = hints_for(obs.url)
        if tier == 0 or hints is not GENERIC_HINTS:
            payload["site_hints"] = hints
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))

    # Try the full view first, then shrink. A provider that rejects the request
    # as too large, or whose per-minute token window is exhausted, will often
    # accept the same step expressed more tersely -- which beats failing a task
    # that was otherwise going fine.
    raw = None
    last_error: Optional[Exception] = None
    for tier in (0, 1, 2):
        try:
            raw = await llm.call("reasoner", SYSTEM, build(tier), task_id=task_id, step=step)
            break
        except llm.ModelError as exc:
            last_error = exc
            message = str(exc).lower()
            if "413" in message or "too large" in message or "429" in message or "rate" in message:
                continue
            raise
    if raw is None:
        raise last_error if last_error else llm.ModelError("reasoner produced nothing")

    user = build(0)
    try:
        action = ActionProposal.model_validate(raw)
    except ValidationError as exc:
        # Exactly one corrective retry, quoting the real validation error.
        retry_user = (
            build(1)
            + "\n\nYour previous reply was rejected by the schema validator:\n"
            + str(exc)[:600]
            + "\n\nReturn ONE corrected JSON action. Use only allowed verbs and an eid "
              "that appears in the observation above."
        )
        raw2 = await llm.call("reasoner", SYSTEM, retry_user, task_id=task_id, step=step)
        action = ActionProposal.model_validate(raw2)

    return _ground(action, obs)
