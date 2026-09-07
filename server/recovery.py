"""Deterministic recovery handlers, tried in order.

None of these consult the model. They are the cheap, predictable repairs for the
four ways a real page usually goes wrong. Three strikes and the task fails
honestly with the last real error attached -- there is no scripted detour around
a genuine blocker.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from .browser_bridge import BridgeError, bridge
from .schemas import Observation


async def attempt(obs: Observation, last_error: str, task_id: str,
                  step: int) -> Optional[Dict[str, Any]]:
    """Run the first applicable handler. Returns a description, or None."""

    # 1. Something is covering the page.
    if obs.page_state.overlay_present:
        try:
            result = await bridge.request(
                "act", {"action": {"action": "dismiss_overlay", "target": {}, "params": {}}},
                task_id=task_id,
            )
            return {"handler": "dismiss-overlay", "result": result,
                    "detail": "an overlay was covering the page; dismissed it"}
        except BridgeError as exc:
            return {"handler": "dismiss-overlay", "error": str(exc),
                    "detail": "could not dismiss the overlay"}

    # 2. The element we wanted has moved or been re-rendered.
    if "stale_element" in (last_error or ""):
        return {"handler": "re-ground", "detail":
                "the target element is gone; taking a fresh observation and re-reasoning"}

    # 3. The page is still loading.
    if obs.page_state.loading:
        try:
            result = await bridge.request(
                "act", {"action": {"action": "wait", "target": {},
                                   "params": {"timeout_ms": 8000}}},
                task_id=task_id,
            )
            return {"handler": "wait-for-load", "result": result,
                    "detail": "page was still loading; waited for it to settle"}
        except BridgeError as exc:
            return {"handler": "wait-for-load", "error": str(exc)}

    # 4. Chrome's own error page.
    if obs.url.startswith("chrome-error://") or "ERR_" in (obs.title or ""):
        try:
            result = await bridge.request("reload", {}, task_id=task_id)
            return {"handler": "reload-error-page", "result": result,
                    "detail": "chrome showed an error page; reloaded once"}
        except BridgeError as exc:
            return {"handler": "reload-error-page", "error": str(exc)}

    # 5. A native JS dialog is blocking script execution.
    if "dialog" in (last_error or "").lower():
        try:
            result = await bridge.request("handle_dialog", {"accept": True}, task_id=task_id)
            return {"handler": "handle-js-dialog", "result": result,
                    "detail": "dismissed a native JavaScript dialog via CDP"}
        except BridgeError as exc:
            return {"handler": "handle-js-dialog", "error": str(exc)}

    return None
