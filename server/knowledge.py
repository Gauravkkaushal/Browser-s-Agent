"""Site-knowledge hint packs.

This is the ONLY module in the system permitted to mention a domain name.

What lives here is *advice for the reasoner*, never control flow. A hint pack is
selected by hostname and pasted into the reasoner's prompt as plain English.
The loop, policy layer, verifier, recovery handlers and executor never see it
and never branch on a domain. If every pack were deleted the agent would still
run -- it would just have to discover each interface from the observation alone.
"""
from __future__ import annotations

from typing import Dict, List
from urllib.parse import urlparse

HINT_PACKS: Dict[str, str] = {
    "web.whatsapp.com": (
        "This is a chat application.\n"
        "- The contact/chat search control is a button or textbox whose accessible "
        "name mentions 'Search'. Click it, then type the contact name.\n"
        "- Search results and conversations are elements with role=listitem. Pick the "
        "one whose name matches the contact, then click it to open the conversation.\n"
        "- THE CONVERSATION IS ALREADY OPEN if an editable textbox named like "
        "'Type a message' is present. That box is the proof. When it is there, "
        "stop trying to open the chat and just use it.\n"
        "- Do NOT click the contact's name in the header bar at the top of the "
        "conversation: that opens the contact-info sidebar, it does not open the "
        "chat. If a contact-info panel appears, you clicked the header -- close "
        "it and go straight to the message box instead of clicking the name "
        "again.\n"
        "- To switch conversation, click the row in the LEFT-HAND list, not the "
        "header.\n"
        "- The message composer is at the bottom: role=textbox and is_editable=true "
        "(it is contenteditable, not an input). Use the `type` verb on it.\n"
        "- The send control's accessible name is usually 'Send'. Sending is "
        "irreversible, so it requires user confirmation.\n"
        "- Pressing Enter in the composer sends the message and is more reliable "
        "than clicking the send button. Prefer keypress Enter with the composer "
        "focused.\n"
        "- VERIFYING A SEND: the composer EMPTIES. Predict that with\n"
        "  expected.element_gone set to a distinctive phrase from your message -- "
        "it is gone from the composer once sent. Do NOT predict text_contains of "
        "your message: it is already on screen in the composer before you send, "
        "so that prediction proves nothing and will be discarded.\n"
        "- If a send appears not to have worked, LOOK at the composer before "
        "trying again: if it is now empty, the message went. Sending twice is "
        "worse than not verifying."
    ),
    "mail.google.com": (
        "This is an email client.\n"
        "- The compose control's accessible name is usually 'Compose'.\n"
        "- The compose window contains: a 'To recipients' textbox (type the address "
        "then press Enter to turn it into a chip), a 'Subject' textbox, and a "
        "'Message Body' textbox which is contenteditable.\n"
        "- The send control's accessible name is usually 'Send'. Sending is "
        "irreversible, so it requires user confirmation.\n"
        "- After sending, a short-lived status message containing 'Message sent' "
        "appears; use `wait` with text_contains to verify it."
    ),
    "www.flipkart.com": (
        "This is a shopping site.\n"
        "- A login prompt overlay often appears on first load. If page_state."
        "overlay_present is true, dismiss it before doing anything else.\n"
        "- The search control is a textbox at the top; type the query and press Enter.\n"
        "- Product results are a repeated grid of cards. Use the `extract` verb to "
        "read names, prices and ratings rather than reading them one element at a time."
    ),
    "www.meesho.com": (
        "This is a shopping site.\n"
        "- The search control is a textbox at the top; type the query and press Enter.\n"
        "- Product results are a repeated grid of cards. Use the `extract` verb to read "
        "names, prices and ratings."
    ),
    "www.amazon.in": (
        "This is a shopping site.\n"
        "- The search control is a textbox at the top; type the query and press Enter.\n"
        "- Product results are a repeated list of cards. Use the `extract` verb."
    ),
    "lms.kiet.edu": (
        "This is a Moodle learning-management site.\n"
        "- The sign-in page has textboxes named 'Username' and 'Password' and a "
        "'Log in' button. If a credential slot exists for this site, use "
        "fill_credential for BOTH fields (never type a password yourself), then "
        "click 'Log in'.\n"
        "- After signing in you land on the Dashboard ('/my/'). Courses are links "
        "in a 'Course overview' region.\n"
        "- An assignment page shows a 'Submission status' table and a button named "
        "'Add submission' or 'Edit submission'.\n"
        "- The submission form has a file picker. Clicking 'Add...' opens a chooser "
        "dialog; prefer the drop-zone's underlying <input type=\"file\"> and use "
        "upload_file on it directly.\n"
        "- Saving is done with a 'Save changes' button. Some assignments then need "
        "'Submit assignment' and a confirmation checkbox -- both are irreversible, "
        "so they will pause for human approval.\n"
        "- Verify by checking the Submission status row reads 'Submitted for "
        "grading'."
    ),
    "meet.google.com": (
        "This is a video-meeting site.\n"
        "- 'New meeting' does NOT create a link. It opens a small MENU. So after "
        "clicking it, the thing to look for is the menu -- not a link. Clicking "
        "it twice because 'nothing happened' just closes the menu you opened.\n"
        "- The menu offers roughly: 'Create a meeting for later', 'Start an "
        "instant meeting', 'Schedule in Google Calendar'.\n"
        "- For a LINK WITHOUT joining a call, choose 'Create a meeting for "
        "later'. A dialog then shows the link as plain text of the form "
        "meet.google.com/xxx-xxxx-xxx. Read it out of page_text and `note` it "
        "AT ONCE -- close the dialog and the link is gone from the page.\n"
        "- 'Start an instant meeting' puts you INSIDE a call and turns on the "
        "camera and microphone. Someone who asked for a link did not ask for "
        "that; prefer 'Create a meeting for later'.\n"
        "- Predict the menu or dialog arriving: element_appears 'meeting for "
        "later', or text_contains 'joining info'. Do NOT predict that the 'New "
        "meeting' button is present -- it is there before and after, so it "
        "proves nothing and will be discarded."
    ),
    "chatgpt.com": (
        "This is a chat assistant.\n"
        "- The composer is a contenteditable textbox near the bottom; use `type` "
        "on it, then press Enter or click the send control.\n"
        "- Replies stream in. After sending, use `wait` with text_contains for a "
        "distinctive phrase, or wait for the stop-generating control to disappear, "
        "before reading the answer out of page_text.\n"
        "- Any file it produces appears as a download link in the reply; click it "
        "and then use list_downloads to find the saved path."
    ),
    "www.google.com": (
        "This is a web search engine.\n"
        "- The search control is a textbox named 'Search' or 'q'. Type the query then "
        "press Enter (a `keypress` with key_combo 'Enter').\n"
        "- Results are links; read their names before choosing which to open.\n"
        "- A consent or cookie dialog may appear on first load; dismiss it first."
    ),
}

# Aliases so a related hostname reuses the same pack.
ALIASES: Dict[str, str] = {
    "chat.openai.com": "chatgpt.com",
    "www.chatgpt.com": "chatgpt.com",
    "flipkart.com": "www.flipkart.com",
    "meesho.com": "www.meesho.com",
    "amazon.in": "www.amazon.in",
    "google.com": "www.google.com",
    "www.google.co.in": "www.google.com",
    "accounts.google.com": "mail.google.com",
}

GENERIC_HINTS = (
    "No hint pack for this site. Work from the observation alone:\n"
    "- Prefer elements whose role and accessible name match your current goal.\n"
    "- If page_state.overlay_present is true, dismiss the overlay before anything else.\n"
    "- To search, focus a textbox, type, then press Enter.\n"
    "- For a repeated list of priced items, use `extract` instead of reading each card."
)


def hints_for(url: str) -> str:
    """Return the advisory text for a URL. Never returns control flow."""
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return GENERIC_HINTS
    if not host:
        return GENERIC_HINTS
    if host in HINT_PACKS:
        return HINT_PACKS[host]
    if host in ALIASES:
        return HINT_PACKS[ALIASES[host]]
    bare = host[4:] if host.startswith("www.") else host
    if bare in ALIASES:
        return HINT_PACKS[ALIASES[bare]]
    for known in HINT_PACKS:
        if host.endswith("." + known) or known.endswith("." + host):
            return HINT_PACKS[known]
    return GENERIC_HINTS


def known_hosts() -> List[str]:
    return sorted(set(list(HINT_PACKS.keys()) + list(ALIASES.keys())))
