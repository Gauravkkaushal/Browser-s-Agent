"""The bridge to the real browser.

Owns the extension's WebSocket and turns it into an awaitable RPC surface:
`await bridge.request("observe")` blocks until the service worker answers with
what the live page actually reported. Every observation the loop reasons about
arrives through here -- there is no other source of page state.

A reconnect keeps the same session_id, so the extension dropping and coming
back mid-task is invisible to the loop apart from the pause.
"""
from __future__ import annotations

import asyncio
import uuid
from typing import Any, Dict, Optional

from .config import BRIDGE_TIMEOUT_S
from .events import bus
from .schemas import Observation, now_iso


class BridgeError(RuntimeError):
    """The browser could not carry out the request, and said why."""


class BrowserBridge:
    def __init__(self) -> None:
        self._socket = None
        self._session_id: Optional[str] = None
        self._pending: Dict[str, asyncio.Future] = {}
        self._connected_at: Optional[str] = None
        self._connect_count = 0

    # -- connection ---------------------------------------------------------
    @property
    def connected(self) -> bool:
        return self._socket is not None

    @property
    def session_id(self) -> Optional[str]:
        return self._session_id

    def status(self) -> Dict[str, Any]:
        return {
            "connected": self.connected,
            "session_id": self._session_id,
            "connected_at": self._connected_at,
            "connect_count": self._connect_count,
            "pending_requests": len(self._pending),
        }

    async def attach(self, socket, session_id: str) -> None:
        self._socket = socket
        self._session_id = session_id
        self._connected_at = now_iso()
        self._connect_count += 1
        await bus.emit("WS_CONNECTED", {
            "session_id": session_id,
            "connect_count": self._connect_count,
            "note": "reconnect resumes the same session" if self._connect_count > 1 else "first connection",
        })

    async def detach(self, socket) -> None:
        if self._socket is not socket:
            return
        self._socket = None
        # Fail every in-flight request loudly rather than letting the loop hang.
        for fut in list(self._pending.values()):
            if not fut.done():
                fut.set_exception(BridgeError("browser disconnected mid-request"))
        self._pending.clear()
        await bus.emit("WS_DISCONNECTED", {"session_id": self._session_id})

    # -- inbound ------------------------------------------------------------
    def resolve(self, req_id: str, payload: Dict[str, Any]) -> None:
        fut = self._pending.pop(req_id, None)
        if fut is not None and not fut.done():
            fut.set_result(payload)

    # -- outbound RPC -------------------------------------------------------
    async def request(self, op: str, args: Optional[Dict[str, Any]] = None,
                      task_id: Optional[str] = None, timeout: Optional[float] = None) -> Dict[str, Any]:
        if self._socket is None:
            raise BridgeError(
                "the browser extension is not connected -- load the unpacked extension "
                "from dist/ and keep a normal http(s) tab open"
            )
        req_id = uuid.uuid4().hex[:12]
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut
        message = {
            "v": 1,
            "type": "BRIDGE_REQUEST",
            "ts": now_iso(),
            "task_id": task_id,
            "step": 0,
            "seq": 0,
            "payload": {"req_id": req_id, "op": op, "args": args or {}},
        }
        try:
            await self._socket.send_json(message)
        except Exception as exc:  # noqa: BLE001
            self._pending.pop(req_id, None)
            raise BridgeError("could not reach the extension: %s" % exc) from exc

        try:
            result = await asyncio.wait_for(fut, timeout or BRIDGE_TIMEOUT_S)
        except asyncio.TimeoutError as exc:
            self._pending.pop(req_id, None)
            raise BridgeError("browser did not answer '%s' within %.0fs" % (op, timeout or BRIDGE_TIMEOUT_S)) from exc

        if not result.get("ok"):
            raise BridgeError(result.get("error") or ("browser refused '%s'" % op))
        return result.get("result", {})

    # -- typed helpers ------------------------------------------------------
    async def observe(self, task_id: Optional[str] = None, screenshot: bool = False,
                      tab_id: Optional[int] = None) -> Observation:
        raw = await self.request("observe", {"screenshot": screenshot, "tab_id": tab_id}, task_id=task_id)
        return Observation.model_validate(raw)

    async def screenshot(self, task_id: Optional[str] = None,
                         tab_id: Optional[int] = None) -> Optional[str]:
        try:
            raw = await self.request("screenshot", {"tab_id": tab_id}, task_id=task_id)
            return raw.get("screenshot")
        except BridgeError:
            return None


bridge = BrowserBridge()
