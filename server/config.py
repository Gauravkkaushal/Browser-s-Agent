"""Runtime configuration, loaded from .env."""
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

PORT = int(os.getenv("PORT", "8787"))
HOST = os.getenv("HOST", "127.0.0.1")

LLM_PROVIDER = os.getenv("LLM_PROVIDER", "ollama,gemini,groq,openrouter,openai").lower()

# ---- OpenRouter (OpenAI-compatible). Several keys rotate on rate limits. ----
OPENROUTER_API_KEYS = [
    k.strip() for k in os.getenv("OPENROUTER_API_KEYS", "").split(",") if k.strip()
]
OPENROUTER_BASE_URL = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
OPENROUTER_PLANNER_MODELS = [m.strip() for m in os.getenv("OPENROUTER_PLANNER_MODELS", "openai/gpt-4o-mini").split(",") if m.strip()]
OPENROUTER_REASONER_MODELS = [m.strip() for m in os.getenv("OPENROUTER_REASONER_MODELS", "openai/gpt-4o-mini").split(",") if m.strip()]

# ---- Groq (OpenAI-compatible) ----
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_BASE_URL = os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1")
GROQ_PLANNER_MODELS = [m.strip() for m in os.getenv("GROQ_PLANNER_MODELS", "openai/gpt-oss-20b,groq/compound-mini").split(",") if m.strip()]
GROQ_REASONER_MODELS = [m.strip() for m in os.getenv("GROQ_REASONER_MODELS", "openai/gpt-oss-120b,openai/gpt-oss-20b,groq/compound").split(",") if m.strip()]

# ---- Direct OpenAI ----
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
OPENAI_PLANNER_MODELS = [m.strip() for m in os.getenv("OPENAI_PLANNER_MODELS", "gpt-4o-mini").split(",") if m.strip()]
OPENAI_REASONER_MODELS = [m.strip() for m in os.getenv("OPENAI_REASONER_MODELS", "gpt-4o").split(",") if m.strip()]

# ---- Gemini ----
# Several keys rotate. The free tier counts requests-per-day per KEY, so a
# second key is literally a second day's allowance -- and the single-key
# version spent the whole budget partway through one task.
def split_keys(value: str) -> list:
    """Comma-separated keys, blanks and stray spaces discarded."""
    return [k.strip() for k in (value or "").split(",") if k.strip()]


GEMINI_API_KEYS = split_keys(
    os.getenv("GEMINI_API_KEYS") or os.getenv("GEMINI_API_KEY", "")
)
# Kept for anything still reading the singular name.
GEMINI_API_KEY = GEMINI_API_KEYS[0] if GEMINI_API_KEYS else ""
GEMINI_PLANNER_MODELS = [m.strip() for m in os.getenv(
    "GEMINI_PLANNER_MODELS",
    "gemini-3.1-flash-lite,gemini-3.5-flash-lite,gemini-flash-lite-latest",
).split(",") if m.strip()]
GEMINI_REASONER_MODELS = [m.strip() for m in os.getenv(
    "GEMINI_REASONER_MODELS",
    "gemini-3.1-flash-lite,gemini-3.5-flash-lite,gemini-flash-lite-latest,gemini-3.6-flash",
).split(",") if m.strip()]

# ---- Ollama (the on-device rung) ----
OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.2")
# A small quantized vision-language model. Used automatically whenever a step
# carries a screenshot -- `ollama pull moondream` (~1.7GB) is enough to try it.
OLLAMA_VISION_MODEL = os.getenv("OLLAMA_VISION_MODEL", "moondream")

# ---- Loop guards ----
# Somewhere harmless to stand when the browser has no ordinary page open at
# all. A blank tab is not injectable, so it has to be a real http(s) address.
FALLBACK_START_URL = os.getenv("FALLBACK_START_URL", "https://www.google.com/")

MAX_STEPS = int(os.getenv("MAX_STEPS", "60"))
# How many times a task may rewrite its own plan. Open-ended commands need at
# least one; more than a few means it is going in circles.
MAX_REPLANS = int(os.getenv("MAX_REPLANS", "3"))
WALL_CLOCK_S = float(os.getenv("WALL_CLOCK_S", "600"))
# Long enough that stepping away does not silently cancel a send. A short
# budget here does not make anything safer -- it just turns "I did not answer
# in two minutes" into "the message never went", with no obvious cause.
CONFIRM_TIMEOUT_S = float(os.getenv("CONFIRM_TIMEOUT_S", "900"))
LOGIN_TIMEOUT_S = float(os.getenv("LOGIN_TIMEOUT_S", "300"))
LOGIN_POLL_S = float(os.getenv("LOGIN_POLL_S", "3"))
SCREENSHOT_EVERY = int(os.getenv("SCREENSHOT_EVERY", "5"))
# A real, measured number, not an aspirational one: the full-tier (tier 0)
# reasoner payload -- objective, plan, history, the whole elements digest --
# typically runs several KB to a few tens of KB on an ordinary page. Anything
# over this is surfaced as a PAYLOAD_BUDGET_EXCEEDED event (informational,
# never blocking -- refusing to send a real step to save a few KB would trade
# task success for a vanity number).
PAYLOAD_BUDGET_KB = int(os.getenv("PAYLOAD_BUDGET_KB", "50"))
ACTION_RETRIES = int(os.getenv("ACTION_RETRIES", "2"))
MAX_CONSECUTIVE_VERIFY_FAILURES = int(os.getenv("MAX_CONSECUTIVE_VERIFY_FAILURES", "3"))
OBSERVATION_MAX_AGE_S = float(os.getenv("OBSERVATION_MAX_AGE_S", "5"))
BRIDGE_TIMEOUT_S = float(os.getenv("BRIDGE_TIMEOUT_S", "90"))
# How long to keep waiting for a page that is still loading before judging it.
# College portals and other slow servers routinely take longer than a browser's
# own idea of "a while"; treating that as failure is just impatience.
SLOW_PAGE_PATIENCE_S = float(os.getenv("SLOW_PAGE_PATIENCE_S", "25"))

# ---- On-device reasoning (Chrome Nano / window.ai) ----
# On by default: every step first tries a bridge round-trip to Chrome's
# built-in model before anything else. When that API is unavailable (most
# Chrome builds), the attempt fails fast (~100-300ms) and control falls
# through to the vision-capable local Ollama rung, then the cloud chain. Set
# LOCAL_REASON_ENABLED=false to skip straight to Ollama/cloud.
LOCAL_REASON_ENABLED = os.getenv("LOCAL_REASON_ENABLED", "true").lower() == "true"

# Send the redacted screenshot to the reasoner alongside the DOM digest so it
# can ground actions in what the page actually looks like -- canvas UIs,
# shadow DOM and other places the DOM walker alone under-reports. Only fires
# on steps that already captured a screenshot (SCREENSHOT_EVERY), so it does
# not add extra capture cost.
VISION_REASONING_ENABLED = os.getenv("VISION_REASONING_ENABLED", "true").lower() == "true"

# ---- Audit ----
AUDIT_DIR = Path(os.getenv("AUDIT_DIR", str(Path.home() / ".browser-agent" / "tasks")))
AUDIT_DIR.mkdir(parents=True, exist_ok=True)
