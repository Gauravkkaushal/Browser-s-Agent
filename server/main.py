"""FastAPI app: the brain's front door.

Two WebSockets:
    /ws/agent    the Chrome extension  (bridge RPC + keepalive)
    /ws/cockpit  the operator UI       (event stream + task control)

Plus a handful of HTTP endpoints for health, audit retrieval and the fixtures
used by the policy demonstration.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse
from pydantic import BaseModel

from . import config, llm
from .browser_bridge import bridge
from .events import audit_path, bus
from .knowledge import known_hosts
from .loop import registry

app = FastAPI(title="Browser Agent", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

TEMPLATES = Path(__file__).parent / "templates"
FIXTURES = Path(__file__).parent / "fixtures"


def _read(directory: Path, name: str) -> str:
    path = directory / name
    if not path.exists():
        raise HTTPException(status_code=404, detail="%s not found" % name)
    return path.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
@app.get("/", include_in_schema=False)
async def root():
    return RedirectResponse(url="/cockpit")


@app.get("/cockpit", response_class=HTMLResponse)
async def cockpit():
    return HTMLResponse(_read(TEMPLATES, "cockpit.html"))


@app.get("/health")
async def health():
    return {
        "ok": True,
        "browser_connected": bridge.connected,
        "bridge": bridge.status(),
        "model_chain": llm.chain_names(),
        "active_task": registry.active_task_id,
        "hint_packs": known_hosts(),
        "guards": {
            "max_steps": config.MAX_STEPS,
            "wall_clock_s": config.WALL_CLOCK_S,
            "confirm_timeout_s": config.CONFIRM_TIMEOUT_S,
            "login_timeout_s": config.LOGIN_TIMEOUT_S,
            "screenshot_every": config.SCREENSHOT_EVERY,
        },
    }


@app.get("/health/models")
async def health_models():
    """Probe every configured provider for real. Slow on purpose."""
    return await llm.health()


@app.get("/tasks")
async def list_tasks():
    return {"active": registry.active_task_id, "tasks": registry.list()}


@app.get("/tasks/{task_id}")
async def get_task(task_id: str):
    task = registry.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="no such task")
    return task.snapshot()


@app.get("/tasks/{task_id}/audit", response_class=PlainTextResponse)
async def get_audit(task_id: str):
    path = audit_path(task_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="no audit file for %s" % task_id)
    return PlainTextResponse(path.read_text(encoding="utf-8"))


@app.get("/tasks/{task_id}/trace")
async def get_trace(task_id: str):
    """The URL-transition trace: the evidence that real navigation happened."""
    path = audit_path(task_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="no audit file for %s" % task_id)
    trace = []
    last_url = None
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            env = json.loads(line)
        except json.JSONDecodeError:
            continue
        if env.get("type") != "OBSERVATION_RECEIVED":
            continue
        url = env["payload"].get("url")
        if url and url != last_url:
            trace.append({
                "ts": env["ts"],
                "step": env["step"],
                "url": url,
                "title": env["payload"].get("title"),
                "interactive_count": env["payload"].get("interactive_count"),
                "element_count": env["payload"].get("element_count"),
            })
            last_url = url
    return {"task_id": task_id, "url_transitions": trace, "count": len(trace)}


class StartBody(BaseModel):
    command: str


@app.post("/tasks")
async def start_task(body: StartBody):
    if not body.command.strip():
        raise HTTPException(status_code=400, detail="command is empty")
    try:
        task = await registry.start(body.command.strip())
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"task_id": task.task_id, "state": task.state}


# --- fixtures used by the policy demonstration -----------------------------
@app.get("/fixtures/payment", response_class=HTMLResponse)
async def fixture_payment():
    return HTMLResponse(_read(FIXTURES, "payment.html"))


@app.get("/fixtures/pii", response_class=HTMLResponse)
async def fixture_pii():
    return HTMLResponse(_read(FIXTURES, "pii.html"))


@app.get("/fixtures/shop", response_class=HTMLResponse)
async def fixture_shop():
    return HTMLResponse(_read(FIXTURES, "shop.html"))


# ---------------------------------------------------------------------------
# WebSocket: the browser extension
# ---------------------------------------------------------------------------
@app.websocket("/ws/agent")
async def ws_agent(socket: WebSocket):
    await socket.accept()
    session_id = socket.query_params.get("session_id", "unknown")
    await bridge.attach(socket, session_id)
    try:
        while True:
            raw = await socket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            mtype = msg.get("type")

            # Keepalive: Chrome only holds the service worker open while
            # messages flow, so answer every ping promptly.
            if mtype == "PING":
                await socket.send_json({"v": 1, "type": "PONG", "payload": {}})
                continue
            if mtype == "BRIDGE_RESPONSE":
                payload = msg.get("payload") or {}
                bridge.resolve(payload.get("req_id", ""), payload)
                continue
            if mtype == "WS_CONNECTED":
                continue
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        pass
    finally:
        await bridge.detach(socket)


# ---------------------------------------------------------------------------
# WebSocket: the cockpit
# ---------------------------------------------------------------------------
@app.websocket("/ws/cockpit")
async def ws_cockpit(socket: WebSocket):
    await socket.accept()
    queue = bus.subscribe()

    await socket.send_json({
        "v": 1, "type": "HELLO", "ts": "", "task_id": None, "step": 0, "seq": 0,
        "payload": {
            "browser_connected": bridge.connected,
            "model_chain": llm.chain_names(),
            "replay": bus.replay(60),
            "active_task": registry.active_task_id,
        },
    })

    async def pump() -> None:
        while True:
            event = await queue.get()
            await socket.send_json(event)

    pump_task = asyncio.create_task(pump())
    try:
        while True:
            raw = await socket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            await _handle_cockpit_message(msg, socket)
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        pass
    finally:
        pump_task.cancel()
        bus.unsubscribe(queue)


async def _handle_cockpit_message(msg: Dict[str, Any], socket: WebSocket) -> None:
    mtype = msg.get("type")
    payload = msg.get("payload") or {}

    if mtype == "TASK_CREATE":
        command = (payload.get("command") or "").strip()
        if not command:
            await bus.emit("ERROR", {"error": "empty command"})
            return
        if not bridge.connected:
            await bus.emit("ERROR", {
                "error": "the Chrome extension is not connected. Load dist/ as an "
                         "unpacked extension and open a normal http(s) tab.",
            })
            return
        try:
            await registry.start(command)
        except RuntimeError as exc:
            await bus.emit("ERROR", {"error": str(exc)})
        return

    if mtype in ("CONFIRMATION_GRANTED", "CONFIRMATION_DENIED"):
        task = registry.get(payload.get("task_id"))
        if task is None:
            await bus.emit("ERROR", {"error": "no task to confirm"})
            return
        task.confirm(mtype == "CONFIRMATION_GRANTED")
        return

    if mtype == "TASK_CANCEL":
        task = registry.get(payload.get("task_id"))
        if task is not None:
            task.cancel()
        return

    if mtype == "PING":
        await socket.send_json({"v": 1, "type": "PONG", "payload": {}})
        return


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server.main:app", host=config.HOST, port=config.PORT, reload=False)
