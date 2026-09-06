"""Model gateway.

Two roles -- PLANNER (fast, command -> plan) and REASONER (strong, observation
-> exactly one ActionProposal). Providers are tried in order and every provider
speaks structured JSON only. OpenRouter keys rotate automatically on rate
limits so a long demo does not die on one exhausted key.
"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx

from . import config
from .events import bus


class ModelError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Provider registry
# ---------------------------------------------------------------------------
class Provider:
    name = "base"

    def available(self) -> bool:
        raise NotImplementedError

    async def complete(self, role: str, system: str, user: str) -> Tuple[str, str]:
        """Return (raw_json_text, model_name)."""
        raise NotImplementedError


class OpenAICompatible(Provider):
    """OpenRouter / Groq / OpenAI / any /chat/completions endpoint."""

    def __init__(self, name: str, base_url: str, keys: List[str],
                 planner_model: str, reasoner_model: str,
                 extra_headers: Optional[Dict[str, str]] = None) -> None:
        self.name = name
        self.base_url = base_url.rstrip("/")
        self.keys = [k for k in keys if k]
        self.planner_model = planner_model
        self.reasoner_model = reasoner_model
        self.extra_headers = extra_headers or {}
        self._key_index = 0

    def available(self) -> bool:
        return bool(self.keys)

    def _model_for(self, role: str) -> str:
        return self.planner_model if role == "planner" else self.reasoner_model

    async def complete(self, role: str, system: str, user: str) -> Tuple[str, str]:
        model = self._model_for(role)
        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.1,
        }
        last_err: Optional[str] = None
        # One attempt per key: rotate past rate-limited / rejected keys.
        for offset in range(max(1, len(self.keys))):
            idx = (self._key_index + offset) % len(self.keys)
            key = self.keys[idx]
            headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json"}
            headers.update(self.extra_headers)
            try:
                async with httpx.AsyncClient(timeout=60.0) as client:
                    res = await client.post(self.base_url + "/chat/completions",
                                            headers=headers, json=body)
                if res.status_code in (401, 402, 403, 429):
                    last_err = "%s key #%d -> HTTP %d" % (self.name, idx + 1, res.status_code)
                    continue
                res.raise_for_status()
                data = res.json()
                text = data["choices"][0]["message"]["content"]
                self._key_index = idx  # remember the key that worked
                return text, model
            except httpx.HTTPError as exc:
                last_err = "%s key #%d -> %s" % (self.name, idx + 1, exc)
                continue
        raise ModelError(last_err or (self.name + ": no usable key"))


class Gemini(Provider):
    name = "gemini"

    def available(self) -> bool:
        return bool(config.GEMINI_API_KEY)

    async def complete(self, role: str, system: str, user: str) -> Tuple[str, str]:
        url = ("https://generativelanguage.googleapis.com/v1beta/models/"
               + config.GEMINI_MODEL + ":generateContent?key=" + config.GEMINI_API_KEY)
        body = {
            "contents": [{"parts": [{"text": system + "\n\n" + user}]}],
            "generationConfig": {"response_mime_type": "application/json", "temperature": 0.1},
        }
        async with httpx.AsyncClient(timeout=60.0) as client:
            res = await client.post(url, json=body)
            res.raise_for_status()
            data = res.json()
        return data["candidates"][0]["content"]["parts"][0]["text"], config.GEMINI_MODEL


class Ollama(Provider):
    name = "ollama"

    def available(self) -> bool:
        return True  # cheap to try; fails fast when not running

    async def complete(self, role: str, system: str, user: str) -> Tuple[str, str]:
        body = {
            "model": config.OLLAMA_MODEL,
            "prompt": system + "\n\n" + user + "\n\nReturn JSON only.",
            "stream": False,
            "format": "json",
        }
        async with httpx.AsyncClient(timeout=90.0) as client:
            res = await client.post(config.OLLAMA_HOST.rstrip("/") + "/api/generate", json=body)
            res.raise_for_status()
            data = res.json()
        return data.get("response", "{}"), config.OLLAMA_MODEL


def _build_chain() -> List[Provider]:
    chain: List[Provider] = []
    openrouter = OpenAICompatible(
        "openrouter", config.OPENROUTER_BASE_URL, config.OPENROUTER_API_KEYS,
        config.OPENROUTER_PLANNER_MODEL, config.OPENROUTER_REASONER_MODEL,
        extra_headers={
            "HTTP-Referer": "http://127.0.0.1:%d" % config.PORT,
            "X-Title": "Browser Agent",
        },
    )
    groq = OpenAICompatible(
        "groq", config.GROQ_BASE_URL, [config.GROQ_API_KEY],
        config.GROQ_PLANNER_MODEL, config.GROQ_REASONER_MODEL,
    )
    openai = OpenAICompatible(
        "openai", config.OPENAI_BASE_URL, [config.OPENAI_API_KEY],
        config.OPENAI_PLANNER_MODEL, config.OPENAI_REASONER_MODEL,
    )
    by_name = {
        "openrouter": openrouter, "groq": groq, "openai": openai,
        "gemini": Gemini(), "ollama": Ollama(),
    }
    if config.LLM_PROVIDER in ("auto", ""):
        order = ["groq", "openrouter", "openai", "gemini", "ollama"]
    else:
        order = [p.strip() for p in config.LLM_PROVIDER.split(",") if p.strip()]
    for name in order:
        provider = by_name.get(name)
        if provider is not None and provider.available():
            chain.append(provider)
    return chain


CHAIN: List[Provider] = _build_chain()


def chain_names() -> List[str]:
    return [p.name for p in CHAIN]


# ---------------------------------------------------------------------------
# JSON extraction: models occasionally wrap JSON in prose or code fences.
# ---------------------------------------------------------------------------
def parse_json(text: str) -> Dict[str, Any]:
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.split("```")[1] if "```" in text[3:] else text[3:]
        if text.lstrip().lower().startswith("json"):
            text = text.lstrip()[4:]
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end > start:
        return json.loads(text[start:end + 1])
    raise ModelError("model did not return JSON: " + text[:200])


async def call(role: str, system: str, user: str,
               task_id: Optional[str] = None, step: int = 0) -> Dict[str, Any]:
    """Run the provider chain until one returns parseable JSON."""
    if not CHAIN:
        raise ModelError(
            "no model provider configured -- set OPENROUTER_API_KEYS or GROQ_API_KEY in .env"
        )
    errors: List[str] = []
    for provider in CHAIN:
        started = time.perf_counter()
        try:
            raw, model = await provider.complete(role, system, user)
            parsed = parse_json(raw)
        except Exception as exc:  # noqa: BLE001 - report every provider failure
            errors.append("%s: %s" % (provider.name, exc))
            continue
        latency_ms = round((time.perf_counter() - started) * 1000, 1)
        await bus.emit(
            "MODEL_CALL_COMPLETED",
            {
                "role": role,
                "provider": provider.name,
                "model": model,
                "latency_ms": latency_ms,
                "chars_in": len(system) + len(user),
                "chars_out": len(raw),
                "fallbacks_before": len(errors),
            },
            task_id=task_id,
            step=step,
        )
        return parsed
    raise ModelError("all providers failed -> " + " | ".join(errors))


async def health() -> Dict[str, Any]:
    """Probe every configured provider once. Used by /health and the cockpit."""
    results = []
    for provider in CHAIN:
        started = time.perf_counter()
        try:
            raw, model = await provider.complete(
                "planner",
                'Reply with JSON only.',
                'Return exactly {"ok": true}',
            )
            parse_json(raw)
            results.append({
                "provider": provider.name, "model": model, "ok": True,
                "latency_ms": round((time.perf_counter() - started) * 1000, 1),
            })
        except Exception as exc:  # noqa: BLE001
            results.append({"provider": provider.name, "ok": False, "error": str(exc)[:200]})
    return {"chain": chain_names(), "providers": results}
