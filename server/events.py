"""Event bus.

Every event the pipeline emits goes through here, and only here. It fans out to
(a) every connected cockpit and (b) a per-task JSONL audit file. The cockpit
renders nothing it did not receive from this bus, which is what makes the UI
trustworthy: there is no other way for text to reach the screen.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from .config import AUDIT_DIR
from .schemas import Envelope, now_iso

# Screenshots are huge; keep them out of the audit file but leave a marker.
_HEAVY_KEYS = ("screenshot",)


class EventBus:
    def __init__(self) -> None:
        self._subscribers: Set[asyncio.Queue] = set()
        self._seq = 0
        self._recent: List[Dict[str, Any]] = []
        self._lock = asyncio.Lock()

    # -- subscription -------------------------------------------------------
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    def replay(self, limit: int = 80) -> List[Dict[str, Any]]:
        return self._recent[-limit:]

    # -- emission -----------------------------------------------------------
    async def emit(
        self,
        type_: str,
        payload: Optional[Dict[str, Any]] = None,
        task_id: Optional[str] = None,
        step: int = 0,
    ) -> Dict[str, Any]:
        async with self._lock:
            self._seq += 1
            seq = self._seq

        env = Envelope(
            type=type_,
            ts=now_iso(),
            task_id=task_id,
            step=step,
            seq=seq,
            payload=payload or {},
        ).model_dump()

        self._recent.append(env)
        if len(self._recent) > 500:
            self._recent = self._recent[-500:]

        for q in list(self._subscribers):
            try:
                q.put_nowait(env)
            except asyncio.QueueFull:
                self._subscribers.discard(q)

        if task_id:
            _append_audit(task_id, env)
        return env


def _strip_heavy(obj: Any) -> Any:
    """Replace screenshot blobs with a size marker so the audit stays readable."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k in _HEAVY_KEYS and isinstance(v, str) and len(v) > 200:
                out[k] = "<jpeg base64 %d bytes, redacted regions applied>" % len(v)
            else:
                out[k] = _strip_heavy(v)
        return out
    if isinstance(obj, list):
        return [_strip_heavy(v) for v in obj]
    return obj


def _append_audit(task_id: str, env: Dict[str, Any]) -> None:
    path: Path = AUDIT_DIR / (task_id + ".jsonl")
    try:
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(_strip_heavy(env), ensure_ascii=False) + "\n")
    except OSError:
        pass


def audit_path(task_id: str) -> Path:
    return AUDIT_DIR / (task_id + ".jsonl")


bus = EventBus()
