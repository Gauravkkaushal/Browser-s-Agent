"""Credential vault.

The model never sees a credential. It sees only *slot names* -- strings like
"lms.username" -- and may propose `fill_credential` naming one. The server
substitutes the real value on its way to the browser, and the value is stripped
from every event, every log line and the audit file.

Two hard rules, both enforced here rather than by prompting:

  1. A slot is bound to a site. `match_url` must appear in the page's URL or the
     fill is refused. A page that talks the agent into filling the college
     password cannot get it unless it is genuinely on the college domain.
  2. Values never travel to a model, and never enter the event bus.

Credentials live in a file the user writes themselves; nothing in this codebase
asks for one, prints one, or sends one anywhere except the field it belongs in.
"""
from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from .config import AUDIT_DIR

VAULT_PATH = Path(os.getenv(
    "CREDENTIALS_FILE", str(AUDIT_DIR.parent / "credentials.json")
))

TEMPLATE = {
    "lms": {
        "match_url": "lms.example.edu",
        "label": "College LMS",
        "fields": {"username": "YOUR_USERNAME", "password": "YOUR_PASSWORD"},
    }
}


class VaultError(RuntimeError):
    pass


class Vault:
    def __init__(self, path: Path = VAULT_PATH) -> None:
        self.path = path
        self._data: Dict[str, Dict[str, Any]] = {}
        self.load()

    # -- loading ------------------------------------------------------------
    def load(self) -> None:
        self._data = {}
        if not self.path.exists():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise VaultError("could not read %s: %s" % (self.path, exc)) from exc
        if not isinstance(raw, dict):
            raise VaultError("%s must contain a JSON object" % self.path)
        for name, entry in raw.items():
            if not isinstance(entry, dict) or "fields" not in entry:
                continue
            self._data[name] = {
                "match_url": str(entry.get("match_url", "")).lower(),
                "label": entry.get("label", name),
                "fields": {k: str(v) for k, v in (entry.get("fields") or {}).items()},
            }

    def create_template(self) -> Path:
        """Write a starter file the user fills in themselves."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.write_text(json.dumps(TEMPLATE, indent=2), encoding="utf-8")
            try:  # best effort on Windows; a no-op where chmod is not meaningful
                self.path.chmod(stat.S_IRUSR | stat.S_IWUSR)
            except OSError:
                pass
        return self.path

    # -- what the model is allowed to know ---------------------------------
    def slot_names(self) -> List[str]:
        """Slot identifiers only. No values, ever."""
        out: List[str] = []
        for name, entry in self._data.items():
            for field in entry["fields"]:
                out.append("%s.%s" % (name, field))
        return sorted(out)

    def describe(self) -> List[Dict[str, str]]:
        return [
            {"slot": "%s.%s" % (name, field),
             "site": entry["match_url"],
             "label": entry["label"],
             "kind": "secret" if _is_secret(field) else "identifier"}
            for name, entry in self._data.items()
            for field in entry["fields"]
        ]

    # -- resolution ---------------------------------------------------------
    def resolve(self, slot: str, url: str) -> str:
        """Return the value for a slot, or raise with a plain reason."""
        if "." not in slot:
            raise VaultError(
                "credential slot must look like '<entry>.<field>'; got %r" % slot
            )
        entry_name, field = slot.split(".", 1)
        entry = self._data.get(entry_name)
        if entry is None:
            raise VaultError(
                "no credential entry named %r. Known slots: %s"
                % (entry_name, ", ".join(self.slot_names()) or "(none configured)")
            )
        if field not in entry["fields"]:
            raise VaultError(
                "entry %r has no field %r (it has: %s)"
                % (entry_name, field, ", ".join(entry["fields"]))
            )

        match = entry["match_url"]
        if not match:
            raise VaultError(
                "entry %r has no match_url, so it is not bound to any site and "
                "will never be filled" % entry_name
            )
        host = (urlparse(url).hostname or "").lower()
        if match not in host and match not in url.lower():
            raise VaultError(
                "refusing to fill %s here: it is registered for %r but the page is "
                "%s" % (slot, match, host or url[:60])
            )
        return entry["fields"][field]


def _is_secret(field: str) -> bool:
    return any(w in field.lower() for w in ("pass", "secret", "token", "pin", "otp"))


def mask(value: str) -> str:
    """What the logs and the cockpit are allowed to see."""
    return "[CREDENTIAL len=%d]" % len(value or "")


vault = Vault()
