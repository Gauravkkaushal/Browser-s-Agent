"""Create or inspect the local credential vault.

    python scripts/setup_credentials.py            # show what is configured
    python scripts/setup_credentials.py --init     # write a starter file
    python scripts/setup_credentials.py --add lms  # add an entry interactively

Values are typed by you, stored only on this machine, and never sent to a model.
Nothing prints a stored value back.
"""
from __future__ import annotations

import getpass
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server.vault import VAULT_PATH, Vault, _is_secret  # noqa: E402


def show() -> None:
    v = Vault()
    print("vault file: %s" % VAULT_PATH)
    if not VAULT_PATH.exists():
        print("  (does not exist yet -- run with --init)")
        return
    entries = v.describe()
    if not entries:
        print("  no usable entries")
        return
    print("  %-26s %-28s %s" % ("SLOT", "BOUND TO SITE", "KIND"))
    for e in entries:
        print("  %-26s %-28s %s" % (e["slot"], e["site"], e["kind"]))
    print("\nThe agent may only fill a slot on the site it is bound to.")
    print("No value above is ever printed, logged, or sent to a model.")


def init() -> None:
    path = Vault().create_template()
    print("wrote %s" % path)
    print("Open it and replace the placeholders, or use --add.")


def add(name: str) -> None:
    VAULT_PATH.parent.mkdir(parents=True, exist_ok=True)
    data = {}
    if VAULT_PATH.exists():
        try:
            data = json.loads(VAULT_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print("existing file is not valid JSON; fix or delete it first")
            return

    print("Adding credential entry %r." % name)
    match = input("  site it is bound to (e.g. lms.kiet.edu): ").strip().lower()
    if not match:
        print("  a site binding is required -- without it the agent will never fill it")
        return
    label = input("  friendly label [%s]: " % name).strip() or name

    fields = {}
    print("  Enter fields. Blank field name finishes.")
    while True:
        field = input("    field name (username / password / ...): ").strip()
        if not field:
            break
        if _is_secret(field):
            value = getpass.getpass("    value for %s (hidden): " % field)
        else:
            value = input("    value for %s: " % field)
        if value:
            fields[field] = value

    if not fields:
        print("  nothing entered; no changes made")
        return

    data[name] = {"match_url": match, "label": label, "fields": fields}
    VAULT_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print("\nSaved %d field(s) for %r, bound to %s" % (len(fields), name, match))
    print("Slots the agent can now name: %s"
          % ", ".join("%s.%s" % (name, f) for f in fields))
    print("The agent will refuse to use them anywhere except %s." % match)


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        show()
    elif args[0] == "--init":
        init()
    elif args[0] == "--add" and len(args) > 1:
        add(args[1])
    else:
        print(__doc__)
