"""PLANNER role: turn a natural-language command into a short ordered plan.

The plan is guidance for the reasoner, not a script. Nothing in the plan is
executed directly -- every step still has to be grounded in a real observation
before any action happens.
"""
from __future__ import annotations

from typing import Optional

from . import llm
from .schemas import Plan, PlanStep

SYSTEM = """You plan browser tasks for an agent that drives a real Chrome browser.

Produce a SHORT ordered plan: the fewest steps that actually accomplish the
command. Each step is a goal expressed in terms of what the user would see, plus
a done_when describing the observable evidence that the step succeeded.

OPEN-ENDED COMMANDS
Some commands cannot be planned properly yet, because the real objective is
written somewhere the agent has not read: "do what he asked me to", "handle
whatever is in my inbox", "complete the assignment that is due". For these,
make step 1 READ the thing, and say plainly in `notes` that the plan will be
rewritten once the real request is known. Do not guess at the content.

The agent may work across several sites in one task: read a request in one
place, gather or produce what it needs somewhere else, and come back to deliver
it. Plan that whole journey when the command implies it.

Rules:
- Never write CSS selectors, coordinates, or code. Steps are goals, not clicks.
- If the task needs a starting website, set start_url to a full https:// URL.
- If the site will require signing in, do NOT plan a sign-in step: the agent
  detects login walls on its own and handles them.
- Actions that send, buy, pay, post or delete are irreversible; make them their
  own final step so the human can approve them.
- 3 to 8 steps. Be concrete about what data must be gathered.

Return JSON exactly:
{"objective": "...", "start_url": "https://..." or null,
 "steps": [{"n": 1, "goal": "...", "done_when": "..."}],
 "notes": "..."}"""


async def make_plan(command: str, task_id: str, current_url: str = "",
                    discovered: str = "", done_so_far: str = "",
                    step: int = 0) -> Plan:
    """Build a plan. Called again mid-task once the real objective is known."""
    parts = [
        "User command:\n%s" % command,
        "The browser is currently on: %s" % (current_url or "(unknown)"),
    ]
    if discovered:
        parts.append(
            "The agent has since READ the actual request. This is what the task "
            "really is:\n%s\n\nPlan the remaining work to carry it out. Do not "
            "re-plan what is already done." % discovered
        )
    if done_so_far:
        parts.append("Already completed:\n%s" % done_so_far)
    user = "\n\n".join(parts)
    data = await llm.call("planner", SYSTEM, user, task_id=task_id, step=step)

    steps = []
    for i, raw in enumerate(data.get("steps") or [], start=1):
        if isinstance(raw, dict):
            steps.append(PlanStep(
                n=int(raw.get("n") or i),
                goal=str(raw.get("goal") or "").strip(),
                done_when=str(raw.get("done_when") or "").strip(),
            ))
        else:
            steps.append(PlanStep(n=i, goal=str(raw).strip()))

    if not steps:
        steps = [PlanStep(n=1, goal=command, done_when="the user's request is satisfied")]

    start_url: Optional[str] = data.get("start_url") or None
    if start_url and not str(start_url).startswith(("http://", "https://")):
        start_url = None

    return Plan(
        objective=str(data.get("objective") or command).strip(),
        steps=steps,
        start_url=start_url,
        notes=str(data.get("notes") or "").strip(),
    )
