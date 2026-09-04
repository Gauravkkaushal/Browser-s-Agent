from typing import List, Dict, Optional, Tuple, Any
from pydantic import BaseModel, Field

class PageElement(BaseModel):
    id: str
    role: str = "generic"
    label: str = ""
    box: Optional[List[int]] = None
    masked: bool = False

class SensitiveRegion(BaseModel):
    id: str
    label: str
    type: str
    confidence: float = 0.95
    source: str = "dom-scanner"
    box: Optional[List[int]] = None

class PrivacySummary(BaseModel):
    regionCount: int = 0
    redactionTypes: Dict[str, int] = Field(default_factory=dict)
    coverage: float = 0.0

class PageInfo(BaseModel):
    origin: str = "about:blank"
    titleHint: str = "Untitled Page"

class AgentRequestPayload(BaseModel):
    task: str = ""
    schemaVersion: Optional[str] = "1.0.0"
    mode: Optional[str] = "balanced"
    page: Optional[PageInfo] = None
    privacySummary: Optional[PrivacySummary] = None
    elements: List[PageElement] = Field(default_factory=list)
    redactions: List[Dict[str, Any]] = Field(default_factory=list)
    visualSummary: Optional[Dict[str, Any]] = None
    ping: Optional[bool] = False

class AgentCommand(BaseModel):
    type: str = "none"  # 'highlight', 'click', 'type', 'none'
    targetId: str = ""
    instruction: str = ""

class ReasonResponse(BaseModel):
    ok: bool = True
    source: str = "server"  # 'server', 'llm-openai', 'llm-gemini', 'llm-ollama', 'server-fallback'
    command: AgentCommand
    rationale: str = ""
    metrics: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
