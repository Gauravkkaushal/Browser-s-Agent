"""Runtime configuration, loaded from .env."""
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

PORT = int(os.getenv("PORT", "8787"))
HOST = os.getenv("HOST", "127.0.0.1")

LLM_PROVIDER = os.getenv("LLM_PROVIDER", "gemini,groq,openrouter,openai,ollama").lower()

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
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_PLANNER_MODELS = [m.strip() for m in os.getenv(
    "GEMINI_PLANNER_MODELS",
    "gemini-flash-lite-latest,gemini-3.5-flash-lite,gemini-2.5-flash-lite",
).split(",") if m.strip()]
GEMINI_REASONER_MODELS = [m.strip() for m in os.getenv(
    "GEMINI_REASONER_MODELS",
    "gemini-flash-lite-latest,gemini-3.5-flash-lite,gemini-3.6-flash,gemini-2.5-flash",
).split(",") if m.strip()]

# ---- Ollama ----
OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.2")

# ---- Loop guards ----
MAX_STEPS = int(os.getenv("MAX_STEPS", "60"))
# How many times a task may rewrite its own plan. Open-ended commands need at
# least one; more than a few means it is going in circles.
MAX_REPLANS = int(os.getenv("MAX_REPLANS", "3"))
WALL_CLOCK_S = float(os.getenv("WALL_CLOCK_S", "600"))
CONFIRM_TIMEOUT_S = float(os.getenv("CONFIRM_TIMEOUT_S", "120"))
LOGIN_TIMEOUT_S = float(os.getenv("LOGIN_TIMEOUT_S", "300"))
LOGIN_POLL_S = float(os.getenv("LOGIN_POLL_S", "3"))
SCREENSHOT_EVERY = int(os.getenv("SCREENSHOT_EVERY", "5"))
ACTION_RETRIES = int(os.getenv("ACTION_RETRIES", "2"))
MAX_CONSECUTIVE_VERIFY_FAILURES = int(os.getenv("MAX_CONSECUTIVE_VERIFY_FAILURES", "3"))
OBSERVATION_MAX_AGE_S = float(os.getenv("OBSERVATION_MAX_AGE_S", "5"))
BRIDGE_TIMEOUT_S = float(os.getenv("BRIDGE_TIMEOUT_S", "90"))
# How long to keep waiting for a page that is still loading before judging it.
# College portals and other slow servers routinely take longer than a browser's
# own idea of "a while"; treating that as failure is just impatience.
SLOW_PAGE_PATIENCE_S = float(os.getenv("SLOW_PAGE_PATIENCE_S", "25"))

# ---- Audit ----
AUDIT_DIR = Path(os.getenv("AUDIT_DIR", str(Path.home() / ".browser-agent" / "tasks")))
AUDIT_DIR.mkdir(parents=True, exist_ok=True)
