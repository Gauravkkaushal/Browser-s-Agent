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


# A rate-limited request is worth waiting out only if the window is short.
# Anything longer and we are better off dropping to the next model.
MAX_429_WAIT_S = 15.0


def _parse_reset(value: str) -> Optional[float]:
    """Groq reports windows like '14.73s', '5m45.6s' or a plain seconds count."""
    if not value:
        return None
    value = value.strip()
    try:
        return float(value)
    except ValueError:
        pass
    total = 0.0
    num = ""
    for ch in value:
        if ch.isdigit() or ch == ".":
            num += ch
        elif ch == "m":
            total += float(num or 0) * 60
            num = ""
        elif ch == "s":
            total += float(num or 0)
            num = ""
    return total or None


class OpenAICompatible(Provider):
    """OpenRouter / Groq / OpenAI / any /chat/completions endpoint.

    Each role gets a *ladder* of models rather than a single one. Free tiers
    meter tokens per minute per model, so when the strong model's window is
    exhausted the next rung keeps the task moving instead of failing it.
    """

    def __init__(self, name: str, base_url: str, keys: List[str],
                 planner_models: List[str], reasoner_models: List[str],
                 extra_headers: Optional[Dict[str, str]] = None) -> None:
        self.name = name
        self.base_url = base_url.rstrip("/")
        self.keys = [k for k in keys if k]
        self.planner_models = [m for m in planner_models if m]
        self.reasoner_models = [m for m in reasoner_models if m]
        self.extra_headers = extra_headers or {}
        self._key_index = 0

    def available(self) -> bool:
        return bool(self.keys) and bool(self.planner_models or self.reasoner_models)

    def _models_for(self, role: str) -> List[str]:
        return self.planner_models if role == "planner" else self.reasoner_models

    async def _attempt(self, model: str, key: str, system: str,
                       user: str) -> Tuple[Optional[str], Optional[str], Optional[float]]:
        """Return (text, error, retry_after_seconds)."""
        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.1,
        }
        headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json"}
        headers.update(self.extra_headers)
        try:
            async with httpx.AsyncClient(timeout=90.0) as client:
                res = await client.post(self.base_url + "/chat/completions",
                                        headers=headers, json=body)
        except httpx.HTTPError as exc:
            return None, "%s/%s -> %s" % (self.name, model, exc), None

        if res.status_code == 429:
            wait = (_parse_reset(res.headers.get("retry-after", ""))
                    or _parse_reset(res.headers.get("x-ratelimit-reset-tokens", ""))
                    or _parse_reset(res.headers.get("x-ratelimit-reset-requests", "")))
            return None, "%s/%s -> HTTP 429 rate limited" % (self.name, model), wait
        if res.status_code in (401, 402, 403):
            return None, "%s/%s -> HTTP %d" % (self.name, model, res.status_code), None
        if res.status_code >= 400:
            detail = ""
            try:
                detail = str(res.json().get("error", {}).get("message", ""))[:160]
            except ValueError:
                detail = res.text[:160]
            return None, "%s/%s -> HTTP %d %s" % (self.name, model, res.status_code, detail), None

        try:
            return res.json()["choices"][0]["message"]["content"], None, None
        except (ValueError, KeyError, IndexError) as exc:
            return None, "%s/%s -> malformed response: %s" % (self.name, model, exc), None

    async def complete(self, role: str, system: str, user: str) -> Tuple[str, str]:
        errors: List[str] = []
        for model in self._models_for(role):
            for offset in range(max(1, len(self.keys))):
                idx = (self._key_index + offset) % len(self.keys)
                key = self.keys[idx]

                text, err, wait = await self._attempt(model, key, system, user)
                if text is not None:
                    self._key_index = idx
                    return text, model

                # A short rate-limit window is worth sitting out once.
                if wait is not None and wait <= MAX_429_WAIT_S:
                    await asyncio.sleep(wait + 0.4)
                    text, err2, _ = await self._attempt(model, key, system, user)
                    if text is not None:
                        self._key_index = idx
                        return text, model
                    err = err2 or err

                errors.append(err or "unknown error")
        raise ModelError(" | ".join(errors[:6]) or (self.name + ": no usable model"))


class Gemini(Provider):
    """Google Generative Language API.

    Also laddered: the newest flash models are periodically returned as 503
    "high demand", and a task should step down a rung rather than die.
    """

    name = "gemini"

    def available(self) -> bool:
        return bool(config.GEMINI_API_KEY)

    def _models_for(self, role: str) -> List[str]:
        return config.GEMINI_PLANNER_MODELS if role == "planner" else config.GEMINI_REASONER_MODELS

    @staticmethod
    def _generation_config(model: str) -> Dict[str, Any]:
        """Keep the model terse.

        Reasoning models spend most of a step's wall-clock on internal thought:
        the same next-action decision measured 13.2s on a thinking model versus
        1.6s on a lite one, for identical output. Cap the output and, where the
        model supports it, turn the thinking budget down -- an agent step is a
        small, well-scoped choice, not a puzzle.
        """
        cfg: Dict[str, Any] = {
            "response_mime_type": "application/json",
            "temperature": 0.1,
            "maxOutputTokens": 1024,
        }
        if "lite" not in model:
            cfg["thinkingConfig"] = {"thinkingLevel": "LOW"}
        return cfg

    async def complete(self, role: str, system: str, user: str) -> Tuple[str, str]:
        errors: List[str] = []
        for model in self._models_for(role):
            body = {
                "systemInstruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": [{"text": user}]}],
                "generationConfig": self._generation_config(model),
            }
            url = ("https://generativelanguage.googleapis.com/v1beta/models/"
                   + model + ":generateContent")
            try:
                async with httpx.AsyncClient(timeout=90.0) as client:
                    res = await client.post(
                        url, json=body,
                        headers={"x-goog-api-key": config.GEMINI_API_KEY,
                                 "Content-Type": "application/json"},
                    )
            except httpx.HTTPError as exc:
                errors.append("gemini/%s -> %s" % (model, exc))
                continue

            if res.status_code in (429, 503):
                # Overloaded or throttled: the next rung is usually free.
                errors.append("gemini/%s -> HTTP %d" % (model, res.status_code))
                continue
            if res.status_code >= 400:
                detail = ""
                try:
                    detail = str(res.json().get("error", {}).get("message", ""))[:140]
                except ValueError:
                    detail = res.text[:140]
                errors.append("gemini/%s -> HTTP %d %s" % (model, res.status_code, detail))
                continue

            try:
                data = res.json()
                parts = data["candidates"][0]["content"]["parts"]
                text = "".join(p.get("text", "") for p in parts)
                if not text.strip():
                    raise KeyError("empty text")
                return text, model
            except (ValueError, KeyError, IndexError) as exc:
                errors.append("gemini/%s -> malformed response: %s" % (model, exc))
                continue
        raise ModelError(" | ".join(errors[:6]) or "gemini: no usable model")


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
        config.OPENROUTER_PLANNER_MODELS, config.OPENROUTER_REASONER_MODELS,
        extra_headers={
            "HTTP-Referer": "http://127.0.0.1:%d" % config.PORT,
            "X-Title": "Browser Agent",
        },
    )
    groq = OpenAICompatible(
        "groq", config.GROQ_BASE_URL, [config.GROQ_API_KEY],
        config.GROQ_PLANNER_MODELS, config.GROQ_REASONER_MODELS,
    )
    openai = OpenAICompatible(
        "openai", config.OPENAI_BASE_URL, [config.OPENAI_API_KEY],
        config.OPENAI_PLANNER_MODELS, config.OPENAI_REASONER_MODELS,
    )
    by_name = {
        "openrouter": openrouter, "groq": groq, "openai": openai,
        "gemini": Gemini(), "ollama": Ollama(),
    }
    if config.LLM_PROVIDER in ("auto", ""):
        order = ["gemini", "groq", "openrouter", "openai", "ollama"]
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
