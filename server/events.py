"""Event bus.

Every event the pipeline emits goes through here, and only here. It fans out to
(a) every connected cockpit and (b) a per-task JSONL audit file. The cockpit
renders nothing it did not receive from this bus, which is what makes the UI
trustworthy: there is no other way for text to reach the screen.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from .config import AUDIT_DIR
from .schemas import Envelope, now_iso

# Screenshots are huge; keep them out of the audit file but leave a marker.
_HEAVY_KEYS = ("screenshot",)

# ---------------------------------------------------------------------------
# Hash chain: each audit line carries the SHA-256 of the previous line's hash
# plus its own contents, the way a append-only ledger does. Tampering with or
# deleting a past line breaks every hash after it -- a reader does not have to
# trust the file, they can verify it (see verify_audit_chain below).
# ---------------------------------------------------------------------------
GENESIS_HASH = "0" * 64
_chain_lock = threading.Lock()
_last_hash: Dict[str, str] = {}


def _load_last_hash(task_id: str) -> str:
    """Resume a chain that already has lines on disk (server restart mid-task)."""
    path = AUDIT_DIR / (task_id + ".jsonl")
    if not path.exists():
        return GENESIS_HASH
    try:
        last_line = None
        with path.open("r", encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    last_line = line
        if not last_line:
            return GENESIS_HASH
        return str(json.loads(last_line).get("audit_hash") or GENESIS_HASH)
    except (OSError, ValueError):
        return GENESIS_HASH


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

        # Notify subscribers; collect any whose queue has overflowed.
        # Emit a visible ERROR to the cockpit before removing it, so the UI
        # can show a "reconnect" banner instead of silently going stale.
        overflowed: List[asyncio.Queue] = []
        for q in list(self._subscribers):
            try:
                q.put_nowait(env)
            except asyncio.QueueFull:
                overflowed.append(q)

        for q in overflowed:
            _overflow_notice = {
                "v": 1, "type": "ERROR", "ts": now_iso(),
                "task_id": task_id, "step": step, "seq": seq,
                "payload": {
                    "error": "Cockpit event queue overflowed — the live stream was "
                             "interrupted. Refresh the cockpit to reconnect.",
                    "overflow": True,
                },
            }
            try:
                # Make room for the notice by discarding the oldest item.
                q.get_nowait()
                q.put_nowait(_overflow_notice)
            except (asyncio.QueueFull, asyncio.QueueEmpty):
                pass
            self._subscribers.discard(q)

        if task_id:
            # Run the file write on a thread-pool worker so the event loop is
            # never blocked by disk I/O (important on slow or networked storage).
            asyncio.create_task(
                asyncio.to_thread(_append_audit, task_id, env)
            )
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
    stripped = _strip_heavy(env)
    path: Path = AUDIT_DIR / (task_id + ".jsonl")
    with _chain_lock:
        prev = _last_hash.get(task_id)
        if prev is None:
            prev = _load_last_hash(task_id)
        # Canonical (sorted-key) encoding so the hash is stable regardless of
        # dict insertion order, then chain it onto the previous line's hash.
        canonical = json.dumps(stripped, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256((prev + canonical).encode("utf-8")).hexdigest()
        stripped["audit_prev_hash"] = prev
        stripped["audit_hash"] = digest
        _last_hash[task_id] = digest
    try:
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(stripped, ensure_ascii=False) + "\n")
    except OSError:
        pass


def audit_path(task_id: str) -> Path:
    return AUDIT_DIR / (task_id + ".jsonl")


def verify_audit_chain(task_id: str) -> Dict[str, Any]:
    """Re-walk a task's audit file and recompute every hash from scratch.

    Returns ok=True only if every line's stored hash matches what its own
    content plus the previous line's hash actually produces -- proof the file
    was not edited or reordered after the fact, not just an assertion that it
    wasn't.
    """
    path = AUDIT_DIR / (task_id + ".jsonl")
    if not path.exists():
        return {"ok": False, "lines": 0, "error": "no audit file for %s" % task_id}

    prev = GENESIS_HASH
    lines_checked = 0
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            env = json.loads(line)
        except json.JSONDecodeError:
            return {"ok": False, "lines": lines_checked, "error": "line %d is not valid JSON" % i}
        stored_hash = env.pop("audit_hash", None)
        stored_prev = env.pop("audit_prev_hash", None)
        if stored_hash is None:
            return {"ok": False, "lines": lines_checked, "error": "line %d has no audit_hash" % i}
        if stored_prev != prev:
            return {"ok": False, "lines": lines_checked,
                    "error": "line %d's prev_hash does not chain from line %d" % (i, i - 1)}
        canonical = json.dumps(env, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        recomputed = hashlib.sha256((prev + canonical).encode("utf-8")).hexdigest()
        if recomputed != stored_hash:
            return {"ok": False, "lines": lines_checked, "error": "line %d's hash does not match its content" % i}
        prev = stored_hash
        lines_checked += 1
    return {"ok": True, "lines": lines_checked, "head_hash": prev}


bus = EventBus()
