import json
import re
import httpx
from typing import Tuple, Dict, Any
from .models import AgentRequestPayload, AgentCommand, ReasonResponse
from .config import (
    LLM_PROVIDER,
    OPENAI_API_KEY,
    OPENAI_BASE_URL,
    OPENAI_MODEL,
    GEMINI_API_KEY,
    GEMINI_MODEL,
    OLLAMA_HOST,
    OLLAMA_MODEL,
)

SYSTEM_PROMPT = """You are NetraShield Autonomous Browser Agent (ISRO SIH 26171).
Your purpose is to inspect the user's current web page graph and task, and determine the safest, most accurate next interaction target.

PRIVACY GUARANTEE:
All sensitive raw values, passwords, financial details, and Indian identity numbers (Aadhaar, PAN, Voter ID, Driving License, GSTIN) have ALREADY been masked locally on-device by NetraShield's content scanner. You only see sanitized labels (e.g. '[REDACTED_AADHAAR]', '[PROTECTED INPUT]').

TASK:
Analyze the provided sanitized interactive elements and the user's intent. Select the single best element to interact with.

OUTPUT FORMAT:
Return strictly valid JSON with this schema:
{
  "type": "highlight" | "none",
  "targetId": "<element id from input>",
  "instruction": "<short, actionable description of why this element is targeted for user confirmation>",
  "rationale": "<brief privacy-preserving reasoning explanation>"
}
"""

async def reason_with_llm(payload: AgentRequestPayload) -> ReasonResponse:
    """Dispatches reasoning to configured LLM provider with fallback to rule planner."""
    provider = LLM_PROVIDER

    # 1. Try OpenAI or compatible API (Groq, OpenRouter, Together)
    if (provider in ("auto", "openai")) and OPENAI_API_KEY:
        try:
            return await _call_openai_compatible(payload)
        except Exception as e:
            print(f"[NetraShield Server] OpenAI call failed: {e}")

    # 2. Try Google Gemini API
    if (provider in ("auto", "gemini")) and GEMINI_API_KEY:
        try:
            return await _call_gemini(payload)
        except Exception as e:
            print(f"[NetraShield Server] Gemini call failed: {e}")

    # 3. Try Local Ollama instance
    if provider in ("auto", "ollama"):
        try:
            return await _call_ollama(payload)
        except Exception:
            pass  # Ollama not running locally is common

    # 4. Built-in Smart Semantic Reasoning Engine
    return _rule_based_reasoning(payload)

async def _call_openai_compatible(payload: AgentRequestPayload) -> ReasonResponse:
    elements_summary = [
        {"id": el.id, "role": el.role, "label": el.label, "masked": el.masked}
        for el in payload.elements[:35]
    ]
    user_content = json.dumps({
        "task": payload.task,
        "pageOrigin": payload.page.origin if payload.page else "unknown",
        "pageTitle": payload.page.titleHint if payload.page else "unknown",
        "elements": elements_summary,
    }, indent=2)

    url = f"{OPENAI_BASE_URL.rstrip('/')}/chat/completions"
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }
    body = {
        "model": OPENAI_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"Decide the next action for:\n{user_content}"},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.2,
    }

    async with httpx.AsyncClient(timeout=10.0) as client:
        res = await client.post(url, headers=headers, json=body)
        res.raise_for_status()
        data = res.json()
        raw_text = data["choices"][0]["message"]["content"]
        parsed = json.loads(raw_text)

        return ReasonResponse(
            ok=True,
            source="llm-openai",
            command=AgentCommand(
                type=parsed.get("type", "highlight"),
                targetId=parsed.get("targetId", ""),
                instruction=parsed.get("instruction", f"Highlight element for task: {payload.task}"),
            ),
            rationale=parsed.get("rationale", "LLM determined safest next step on sanitized graph."),
        )

async def _call_gemini(payload: AgentRequestPayload) -> ReasonResponse:
    elements_summary = [
        {"id": el.id, "role": el.role, "label": el.label, "masked": el.masked}
        for el in payload.elements[:35]
    ]
    prompt_text = f"{SYSTEM_PROMPT}\n\nUser Task: {payload.task}\nPage Graph: {json.dumps(elements_summary)}"

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
    body = {
        "contents": [{"parts": [{"text": prompt_text}]}],
        "generationConfig": {"response_mime_type": "application/json"},
    }

    async with httpx.AsyncClient(timeout=10.0) as client:
        res = await client.post(url, json=body)
        res.raise_for_status()
        data = res.json()
        raw_text = data["candidates"][0]["content"]["parts"][0]["text"]
        parsed = json.loads(raw_text)

        return ReasonResponse(
            ok=True,
            source="llm-gemini",
            command=AgentCommand(
                type=parsed.get("type", "highlight"),
                targetId=parsed.get("targetId", ""),
                instruction=parsed.get("instruction", f"Target selected by Gemini for: {payload.task}"),
            ),
            rationale=parsed.get("rationale", "Gemini evaluated sanitized page representation."),
        )

async def _call_ollama(payload: AgentRequestPayload) -> ReasonResponse:
    elements_summary = [
        {"id": el.id, "role": el.role, "label": el.label}
        for el in payload.elements[:30]
    ]
    prompt = f"{SYSTEM_PROMPT}\nTask: {payload.task}\nElements: {json.dumps(elements_summary)}\nReturn JSON only:"

    url = f"{OLLAMA_HOST.rstrip('/')}/api/generate"
    body = {
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
        "format": "json",
    }

    async with httpx.AsyncClient(timeout=6.0) as client:
        res = await client.post(url, json=body)
        res.raise_for_status()
        data = res.json()
        parsed = json.loads(data.get("response", "{}"))

        return ReasonResponse(
            ok=True,
            source="llm-ollama",
            command=AgentCommand(
                type=parsed.get("type", "highlight"),
                targetId=parsed.get("targetId", ""),
                instruction=parsed.get("instruction", f"Ollama local LLM targeting {parsed.get('targetId')}"),
            ),
            rationale=parsed.get("rationale", "Processed by local Ollama instance."),
        )

def _rule_based_reasoning(payload: AgentRequestPayload) -> ReasonResponse:
    """Smart Semantic Rule-Based Reasoning Planner for zero-leak instant execution."""
    task = (payload.task or "").lower()
    elements = payload.elements or []

    # Intent keyword matching matching our 8 classes
    intent_patterns = {
        "login": re.compile(r"login|log in|sign in|auth|credential|user|password", re.I),
        "pay": re.compile(r"pay|payment|checkout|buy|purchase|order|upi|card", re.I),
        "save": re.compile(r"save|submit|apply|done|record|store|confirm", re.I),
        "send": re.compile(r"send|message|chat|post|dispatch|mail|share", re.I),
        "search": re.compile(r"search|find|query|lookup|filter|browse", re.I),
        "delete": re.compile(r"delete|remove|clear|discard|trash|erase|cancel", re.I),
        "navigate": re.compile(r"navigate|home|back|forward|open|menu|link|goto", re.I),
        "download": re.compile(r"download|export|fetch|extract|backup|csv", re.I),
    }

    # Detect dominant intent from task
    detected_intent = "save"
    for intent_name, pattern in intent_patterns.items():
        if pattern.search(task):
            detected_intent = intent_name
            break

    # Score elements against detected intent
    pattern = intent_patterns.get(detected_intent, re.compile(r"submit|continue|next|button", re.I))
    best_element = None
    best_score = -1

    for el in elements:
        score = 0
        text = f"{el.label} {el.role} {el.id}".lower()
        if pattern.search(text):
            score += 5
        if el.role in ("button", "link"):
            score += 2
        if el.role == "input":
            score += 1
        if el.masked:
            score -= 1  # Prefer actionable buttons over protected sensitive fields

        if score > best_score:
            best_score = score
            best_element = el

    if best_element:
        target_label = best_element.label or best_element.role
        return ReasonResponse(
            ok=True,
            source="server-rule-engine",
            command=AgentCommand(
                type="highlight",
                targetId=best_element.id,
                instruction=f"[Server Engine] Identified action for intent '{detected_intent}'. Target element '{target_label}' (ID: {best_element.id}) highlighted for confirmation.",
            ),
            rationale=f"Server analyzed sanitized DOM tree and matched '{detected_intent}' intent with zero PII exposure.",
        )

    # Fallback to first interactive button or safe element
    fallback_el = next((el for el in elements if el.role in ("button", "link")), elements[0] if elements else None)
    if fallback_el:
        return ReasonResponse(
            ok=True,
            source="server-fallback",
            command=AgentCommand(
                type="highlight",
                targetId=fallback_el.id,
                instruction=f"[Server Fallback] Highlighted {fallback_el.label or fallback_el.role} as the safest interactive target.",
            ),
            rationale="No exact intent match found; suggested default primary control.",
        )

    return ReasonResponse(
        ok=True,
        source="server-fallback",
        command=AgentCommand(
            type="none",
            targetId="",
            instruction="No safe actionable element found on this sanitized page.",
        ),
        rationale="Evaluated sanitized DOM graph; view appears informational only.",
    )
