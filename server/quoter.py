from typing import List
from . import llm

SYSTEM_PROMPT = """You are the OUTGOING-CONTENT WRITER.
INPUT you receive: the USER'S original request + TRUSTED NOTES gathered by the browsing agent.
You NEVER see web page content.
Write ONLY the final outgoing message/body. No explanations. Return exactly JSON.
If information required by the user's request is MISSING from the trusted notes, output exactly: {"message": "[NEED_MORE_INFO]"}

Examples:
  intent: "message Rahul and complete his task, then reply"
  notes: ["Rahul's task: send SIH PS 171 docs"] -> {"message": "Done - SIH PS 171 docs (ISRO, On-device Visual Perception for Light-weight Browser Agents) sent. Anything else?"}
  intent: "reply to Riya that I'll reach in 20 minutes"
  notes: [] -> {"message": "I'll reach in 20 minutes"}
"""

async def compose_message(user_intent: str, trusted_notes: List[str], purpose: str) -> str:
    user_content = f"intent: {user_intent}\n"
    user_content += f"purpose of this message: {purpose}\n"
    if trusted_notes:
        user_content += f"notes: {trusted_notes}"
    else:
        user_content += "notes: []"

    data = await llm.call("planner", SYSTEM_PROMPT, user_content, task_id="quoter", step=0)
    return str(data.get("message") or "")
