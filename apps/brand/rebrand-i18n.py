#!/usr/bin/env python3
"""Rebrand Immich's UI texts as "Memento", at build time.

Rewrites immich/i18n/*.json (all 89 languages) in place, replacing "Immich" with
"Memento" in the texts users see. The build scripts run this just before building and
put the original files back afterwards, so the repo keeps Immich's original
translations and future Immich releases merge without conflicts.

Texts about Immich the project keep its name, because they describe Immich's company,
releases, support or purchases, and renaming them would make them wrong (see KEEP).
Technical text is never touched: only "Immich" with a capital I is replaced, and not
inside web addresses (immich.app, my.immich.app, github.com/immich-app).

Usage: rebrand-i18n.py <path to immich>
"""

import json
import re
import sys
from pathlib import Path

# Keys (or key prefixes ending in "_") whose text stays as it is, in every language.
KEEP = (
    "buy",                         # "Purchase Immich"
    "purchase_",                   # buying a product key from Immich (FUTO)
    "official_immich_resources",   # links to Immich's docs, GitHub, chat
    "obtainium_",                  # installing the app from Immich's GitHub releases
    "support_",                    # Immich's official support channels
    "my_immich_",                  # my.immich.app, Immich's link service
    "version_announcement_",       # "A new version of Immich is available" (with release notes)
)

NAME = re.compile(r"(?<![/.\w-])Immich(?!\.app)")


def keep(key: str) -> bool:
    return any(key == k or (k.endswith("_") and key.startswith(k)) for k in KEEP)


def rebrand(value):
    if isinstance(value, str):
        return NAME.sub("Memento", value)
    if isinstance(value, dict):
        return {k: rebrand(v) for k, v in value.items()}
    if isinstance(value, list):
        return [rebrand(v) for v in value]
    return value


def main() -> None:
    i18n = Path(sys.argv[1]) / "i18n"
    files = sorted(i18n.glob("*.json"))
    if not files:
        sys.exit(f"No translation files in {i18n}")
    changed = 0
    for path in files:
        text = path.read_text(encoding="utf-8")
        data = json.loads(text)
        out = {k: (v if keep(k) else rebrand(v)) for k, v in data.items()}
        if out != data:
            changed += sum(1 for k in data if out[k] != data[k])
            # Same layout as Immich's files (2-space indent, UTF-8 kept as is).
            path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Rebranded {changed} texts in {len(files)} languages (Immich -> Memento).")


if __name__ == "__main__":
    main()
