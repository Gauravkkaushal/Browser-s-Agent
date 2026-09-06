"""Runtime configuration, loaded from .env."""
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

PORT = int(os.getenv("PORT", "8787"))
HOST = os.getenv("HOST", "127.0.0.1")

LLM_PROVIDER = os.getenv("LLM_PROVIDER", "groq,openrouter,openai,gemini,ollama").lower()

# ---- OpenRouter (OpenAI-compatible). Several keys rotate on rate limits. ----
OPENROUTER_API_KEYS = [
    k.strip() for k in os.getenv("OPENROUTER_API_KEYS", "").split(",") if k.strip()
]
OPENROUTER_BASE_URL = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
OPENROUTER_PLANNER_MODEL = os.getenv("OPENROUTER_PLANNER_MODEL", "openai/gpt-4o-mini")
OPENROUTER_REASONER_MODEL = os.getenv("OPENROUTER_REASONER_MODEL", "openai/gpt-4o-mini")

# ---- Groq (OpenAI-compatible) ----
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_BASE_URL = os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1")
GROQ_PLANNER_MODEL = os.getenv("GROQ_PLANNER_MODEL", "openai/gpt-oss-20b")
GROQ_REASONER_MODEL = os.getenv("GROQ_REASONER_MODEL", "openai/gpt-oss-120b")

# ---- Direct OpenAI ----
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
OPENAI_PLANNER_MODEL = os.getenv("OPENAI_PLANNER_MODEL", "gpt-4o-mini")
OPENAI_REASONER_MODEL = os.getenv("OPENAI_REASONER_MODEL", "gpt-4o")

# ---- Gemini ----
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-1.5-flash")

# ---- Ollama ----
OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.2")

# ---- Loop guards ----
MAX_STEPS = int(os.getenv("MAX_STEPS", "60"))
WALL_CLOCK_S = float(os.getenv("WALL_CLOCK_S", "600"))
CONFIRM_TIMEOUT_S = float(os.getenv("CONFIRM_TIMEOUT_S", "120"))
LOGIN_TIMEOUT_S = float(os.getenv("LOGIN_TIMEOUT_S", "300"))
LOGIN_POLL_S = float(os.getenv("LOGIN_POLL_S", "3"))
SCREENSHOT_EVERY = int(os.getenv("SCREENSHOT_EVERY", "5"))
ACTION_RETRIES = int(os.getenv("ACTION_RETRIES", "2"))
MAX_CONSECUTIVE_VERIFY_FAILURES = int(os.getenv("MAX_CONSECUTIVE_VERIFY_FAILURES", "3"))
OBSERVATION_MAX_AGE_S = float(os.getenv("OBSERVATION_MAX_AGE_S", "5"))
BRIDGE_TIMEOUT_S = float(os.getenv("BRIDGE_TIMEOUT_S", "45"))

# ---- Audit ----
AUDIT_DIR = Path(os.getenv("AUDIT_DIR", str(Path.home() / ".browser-agent" / "tasks")))
AUDIT_DIR.mkdir(parents=True, exist_ok=True)
