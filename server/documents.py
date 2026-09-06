"""Reading documents the DOM cannot show.

Chrome renders a PDF with its own viewer, and that viewer is a plugin document:
the page contains an `<embed>` and nothing else. Walking it finds no text and no
controls, which is indistinguishable from a broken page -- so the agent scrolls,
waits, switches tabs, and finally gives up, when the truth is only that the
words were never in the DOM.

The bytes are fetched by the CONTENT SCRIPT, so the request carries the user's
own cookies; a document behind a college login is the ordinary case. This module
only turns those bytes into text.
"""
from __future__ import annotations

import base64
import io
from typing import Any, Dict

# Cap what goes into a prompt. A long paper is worth summarising; the whole of
# it is not worth paying for on every step of the loop.
TEXT_CAP = 60000


class DocumentError(RuntimeError):
    """The document could not be turned into text, and why."""


def extract_pdf_text(data_b64: str) -> Dict[str, Any]:
    """Return the text of a base64 PDF, page by page."""
    try:
        from pypdf import PdfReader
    except ImportError as exc:  # pragma: no cover - depends on the install
        raise DocumentError(
            "reading PDFs needs the pypdf package: pip install -r server/requirements.txt"
        ) from exc

    try:
        raw = base64.b64decode(data_b64)
    except (ValueError, TypeError) as exc:
        raise DocumentError("the document did not arrive as valid base64") from exc

    try:
        reader = PdfReader(io.BytesIO(raw))
    except Exception as exc:  # noqa: BLE001 - pypdf raises many shapes
        raise DocumentError("this file could not be opened as a PDF: %s" % exc) from exc

    if getattr(reader, "is_encrypted", False):
        # An empty password opens a surprising number of "protected" files.
        try:
            reader.decrypt("")
        except Exception:  # noqa: BLE001
            raise DocumentError(
                "this PDF is password-protected, so its text cannot be read"
            ) from None

    parts = []
    pages_read = 0
    for page in reader.pages:
        try:
            text = page.extract_text() or ""
        except Exception:  # noqa: BLE001 - one bad page must not lose the rest
            continue
        if text.strip():
            pages_read += 1
            parts.append(text)
        if sum(len(p) for p in parts) > TEXT_CAP:
            break

    text = "\n\n".join(parts).strip()
    if not text:
        # Say which of the two it is. "No text" from a scan is a different
        # problem from "no text" because parsing failed, and only one of them
        # is worth the agent trying anything else.
        raise DocumentError(
            "this PDF has %d page(s) but no extractable text -- it is almost "
            "certainly a scan of images, which would need OCR to read"
            % len(reader.pages)
        )

    return {
        "text": text[:TEXT_CAP],
        "pages": len(reader.pages),
        "pages_with_text": pages_read,
        "truncated": len(text) > TEXT_CAP,
        "bytes": len(raw),
    }
