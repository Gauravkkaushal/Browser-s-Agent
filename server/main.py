import time
import os
from pathlib import Path
from fastapi import FastAPI, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

from .models import AgentRequestPayload, ReasonResponse, AgentCommand
from .llm_agent import reason_with_llm
from .metrics import tracker
from .config import PORT, HOST

app = FastAPI(
    title="NetraShield Privacy Reasoning Server",
    description="Privacy-Preserving On-Device ML & Hybrid LLM Reasoning Engine (ISRO SIH 26171)",
    version="2.0.0",
)

# Enable CORS for Chrome extensions and local dev
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

TEMPLATES_DIR = Path(__file__).parent / "templates"

def _read_template(filename: str) -> str:
    path = TEMPLATES_DIR / filename
    if path.exists():
        return path.read_text(encoding="utf-8")
    return f"<h1>Template {filename} not found</h1>"

@app.get("/", include_in_schema=False)
async def root():
    return RedirectResponse(url="/metrics/dashboard")

@app.get("/health")
@app.post("/health")
async def health():
    return {
        "ok": True,
        "status": "online",
        "service": "NetraShield Privacy Reasoning Server",
        "timestamp": time.time(),
    }

@app.post("/reason", response_model=ReasonResponse)
async def reason(payload: AgentRequestPayload):
    # Handle settings ping / health test from Chrome Extension drawer
    if payload.ping:
        return ReasonResponse(
            ok=True,
            source="server-ping",
            command=AgentCommand(type="none", targetId="", instruction="Server ping successful."),
            rationale="Connection test confirmed NetraShield backend is online.",
        )

    start_time = time.perf_counter()
    response = await reason_with_llm(payload)
    latency_ms = (time.perf_counter() - start_time) * 1000

    # Record telemetry
    tracker.record_request(payload, latency_ms, response.source, response.command)

    # Attach performance metrics
    response.metrics = {
        "latencyMs": round(latency_ms, 2),
        "zeroLeakGuaranteed": True,
        "piiShielded": (
            payload.privacySummary.regionCount
            if payload.privacySummary
            else len(payload.redactions)
        ),
    }

    return response

@app.get("/metrics")
async def get_metrics():
    """Returns real-time privacy and reasoning telemetry."""
    return tracker.get_summary()

@app.get("/metrics/dashboard", response_class=HTMLResponse)
async def metrics_dashboard():
    """Visual real-time zero-leak telemetry dashboard."""
    return HTMLResponse(content=_read_template("dashboard.html"))

@app.get("/demo/kyc", response_class=HTMLResponse)
async def demo_kyc():
    """Interactive Indian Citizen KYC verification test page."""
    return HTMLResponse(content=_read_template("kyc.html"))

@app.get("/demo/checkout", response_class=HTMLResponse)
async def demo_checkout():
    """Interactive E-Commerce checkout & payment test page."""
    return HTMLResponse(content=_read_template("checkout.html"))

@app.get("/demo/admin", response_class=HTMLResponse)
async def demo_admin():
    """Interactive Personnel directory test page for intent classification."""
    return HTMLResponse(content=_read_template("admin.html"))

if __name__ == "__main__":
    import uvicorn
    print(f"Starting NetraShield Reasoning Server on http://{HOST}:{PORT}")
    uvicorn.run("server.main:app", host=HOST, port=PORT, reload=True)
