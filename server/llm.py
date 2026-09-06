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


# --- one connection pool for the whole process -----------------------------
#
# Every model call used to build its own AsyncClient, which means a fresh TCP
# connection and a fresh TLS handshake to the API -- on a task that takes forty
# model calls, that is forty handshakes bought and thrown away. A shared client
# keeps the connection open and reuses it, and enables HTTP/2 where the provider
# offers it.
#
# The timeout matters just as much. It used to be 90 seconds per provider, so a
# single hung endpoint stalled the whole task for a minute and a half before the
# ladder even got to try the next rung -- and the whole point of having a ladder
# is that the next rung is usually fine. Connecting is given a short leash;
# reading is given enough room for a slow-but-alive model.
HTTP_TIMEOUT = httpx.Timeout(connect=6.0, read=45.0, write=15.0, pool=5.0)
_CLIENT: Optional[httpx.AsyncClient] = None


def client() -> httpx.AsyncClient:
    global _CLIENT
    if _CLIENT is None or _CLIENT.is_closed:
        _CLIENT = httpx.AsyncClient(
            timeout=HTTP_TIMEOUT,
            limits=httpx.Limits(max_keepalive_connections=8, max_connections=16),
        )
    return _CLIENT


async def aclose() -> None:
    global _CLIENT
    if _CLIENT is not None and not _CLIENT.is_closed:
        await _CLIENT.aclose()
    _CLIENT = None



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

    async def _attempt(self, model: str, key: str, system: str, user: str,
                       image_b64: str = "",
                       no_json_mode: bool = False) -> Tuple[Optional[str], Optional[str], Optional[float]]:
        """Return (text, error, retry_after_seconds)."""
        # With an image the user turn becomes a list of parts. Everything else
        # about the request is unchanged.
        content: Any = user
        if image_b64:
            content = [
                {"type": "text", "text": user},
                {"type": "image_url",
                 "image_url": {"url": "data:image/jpeg;base64," + image_b64}},
            ]
        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": content},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.1,
        }
        if no_json_mode:
            # Some rungs answer 400 "Tool choice is none, but model called a
            # tool" when json_object mode is set -- the model tries to satisfy
            # it with a tool call the request forbids. Asking in words works,
            # and parse_json copes with a fenced or prose-wrapped object.
            body.pop("response_format", None)
            body["messages"][0]["content"] = (
                system + "\n\nReply with a single JSON object and nothing else.")
        headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json"}
        headers.update(self.extra_headers)
        try:
            res = await client().post(self.base_url + "/chat/completions",
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

    async def complete(self, role: str, system: str, user: str,
                       image_b64: str = "") -> Tuple[str, str]:
        errors: List[str] = []
        for model in self._models_for(role):
            for offset in range(max(1, len(self.keys))):
                idx = (self._key_index + offset) % len(self.keys)
                key = self.keys[idx]

                text, err, wait = await self._attempt(model, key, system, user, image_b64)
                if text is not None:
                    self._key_index = idx
                    return text, model

                # A model that refuses json_object mode will refuse it every
                # time. Ask again in plain words rather than burning the rung.
                if err and "called a tool" in err:
                    text, err2, _ = await self._attempt(
                        model, key, system, user, image_b64, no_json_mode=True)
                    if text is not None:
                        self._key_index = idx
                        return text, model
                    err = err2 or err

                # A short rate-limit window is worth sitting out once.
                if wait is not None and wait <= MAX_429_WAIT_S:
                    await asyncio.sleep(wait + 0.4)
                    text, err2, _ = await self._attempt(model, key, system, user, image_b64)
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

    def __init__(self) -> None:
        # Start wherever the last call left off, so load spreads across keys
        # instead of always hammering the first one.
        self._key_index = 0

    def available(self) -> bool:
        return bool(config.GEMINI_API_KEYS)

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

    async def complete(self, role: str, system: str, user: str,
                       image_b64: str = "") -> Tuple[str, str]:
        errors: List[str] = []
        keys = config.GEMINI_API_KEYS or [""]
        # Keys the API has already refused outright during this call. Retrying
        # them on the next rung only wastes a round trip each time.
        dead: set = set()
        for model in self._models_for(role):
            parts: List[Dict[str, Any]] = [{"text": user}]
            if image_b64:
                parts.append({"inline_data": {"mime_type": "image/jpeg",
                                              "data": image_b64}})
            body = {
                "systemInstruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": parts}],
                "generationConfig": self._generation_config(model),
            }
            url = ("https://generativelanguage.googleapis.com/v1beta/models/"
                   + model + ":generateContent")

            # The free tier's request-per-day allowance is counted per KEY, so
            # a second key is a second day's worth. Rotate through them before
            # stepping down to a weaker model: a fresh key on the good rung
            # beats an exhausted key on a worse one.
            res = None
            throttled = 0
            for offset in range(len(keys)):
                idx = (self._key_index + offset) % len(keys)
                if idx in dead:
                    continue
                try:
                    attempt = await client().post(
                        url, json=body,
                        headers={"x-goog-api-key": keys[idx],
                                 "Content-Type": "application/json"},
                    )
                except httpx.HTTPError as exc:
                    errors.append("gemini/%s -> %s" % (model, exc))
                    continue
                if attempt.status_code in (429, 503):
                    # This key is spent (or the model is busy); try the next.
                    throttled += 1
                    continue
                if attempt.status_code in (401, 403):
                    # A revoked or unauthorised key answers this on EVERY model,
                    # so without skipping it here one dead key poisons the whole
                    # ladder -- every rung fails on the same permission error
                    # while two working keys sit unused behind it.
                    dead.add(idx)
                    throttled += 1
                    continue
                self._key_index = idx
                res = attempt
                break

            if res is None:
                errors.append(
                    "gemini/%s -> all %d key(s) throttled, refused or unreachable%s"
                    % (model, throttled or len(keys),
                       " (%d key(s) permanently refused)" % len(dead) if dead else ""))
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

    async def complete(self, role: str, system: str, user: str,
                       image_b64: str = "") -> Tuple[str, str]:
        if image_b64:
            raise ModelError("the local ollama rung does not take images here")
        body = {
            "model": config.OLLAMA_MODEL,
            "prompt": system + "\n\n" + user + "\n\nReturn JSON only.",
            "stream": False,
            "format": "json",
        }
        res = await client().post(config.OLLAMA_HOST.rstrip("/") + "/api/generate",
                                  json=body)
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
    raise ModelError(_explain_chain_failure(errors))


def _explain_chain_failure(errors: List[str]) -> str:
    """Say what a reader can act on, then the detail.

    A hundred lines of provider errors is not an explanation. Nearly always the
    real story is one of three things -- the day's free quota is gone, the
    credit is gone, or a model has been retired -- and each has a different
    answer.
    """
    blob = " | ".join(errors)
    lead: List[str] = []
    if "429" in blob or "rate limit" in blob.lower():
        lead.append(
            "every model rung is rate limited. Free tiers cap REQUESTS PER DAY, "
            "and the light models allow far more of them than the full ones -- "
            "put the *-flash-lite rungs first in GEMINI_REASONER_MODELS"
        )
    if "402" in blob:
        lead.append("the OpenRouter key is out of credit (HTTP 402)")
    if "404" in blob and "no longer available" in blob:
        lead.append(
            "a configured model has been retired (HTTP 404) -- remove it from "
            "the ladder in .env"
        )
    if "All connection attempts failed" in blob:
        lead.append("the local ollama fallback is not running")
    if not lead:
        lead.append("no model provider could answer")
    return "; ".join(lead) + ".\n\nDetail: " + blob[:900]


async def call_vision(role: str, system: str, user: str, image_b64: str,
                      task_id: Optional[str] = None, step: int = 0) -> Dict[str, Any]:
    """Ask a model to read an IMAGE, for pages no content script can reach.

    chrome:// pages, the Web Store and Chrome's own PDF viewer are closed to
    extensions by the browser itself -- no amount of retrying opens them. A
    picture of the screen is the only thing left, and it is what a person in
    the same position would use.

    Rungs that cannot see stay in the ladder and simply fail their attempt; the
    next one is tried. If none can, that is reported rather than guessed at.
    """
    if not CHAIN:
        raise ModelError("no model provider configured")
    errors: List[str] = []
    for provider in CHAIN:
        started = time.perf_counter()
        try:
            raw, model = await provider.complete(role, system, user, image_b64=image_b64)
            parsed = parse_json(raw)
        except Exception as exc:  # noqa: BLE001 - every rung's failure is reportable
            errors.append("%s: %s" % (provider.name, exc))
            continue
        await bus.emit("MODEL_CALL_COMPLETED", {
            "role": role, "provider": provider.name, "model": model,
            "latency_ms": round((time.perf_counter() - started) * 1000, 1),
            "chars_in": len(system) + len(user), "chars_out": len(raw),
            "image_bytes": len(image_b64), "vision": True,
            "fallbacks_before": len(errors),
        }, task_id=task_id, step=step)
        return parsed
    raise ModelError("no model in the chain could read an image -> " + " | ".join(errors[:4]))


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
