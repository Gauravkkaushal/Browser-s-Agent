import os
from dotenv import load_dotenv

load_dotenv()

PORT = int(os.getenv("PORT", "8787"))
HOST = os.getenv("HOST", "0.0.0.0")

# LLM Provider: 'auto', 'openai', 'gemini', 'ollama', 'mock'
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "auto").lower()

# API Keys & Endpoints
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-1.5-flash")

OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.2")
