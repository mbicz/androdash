#!/usr/bin/env python3
"""Check local Markdown links in the AndroDash repository.

Standard library only. Ignores external URLs, pure anchors, and mailto links.
Reports missing relative targets with file:line and exits non-zero.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
MARKDOWN_ROOTS = [
    ROOT / "docs",
    ROOT / "changelog.d",
    ROOT / "contracts",
    ROOT / "app",
    ROOT / "web",
    ROOT / "tools",
]
MARKDOWN_FILES = [
    ROOT / "README.md",
    ROOT / "AGENTS.md",
    ROOT / "CONSTITUTION.md",
]

LINK_RE = re.compile(r"(!?)\[[^\]]*\]\(([^)\n]+)\)")
FENCE_RE = re.compile(r"^\s*(```|~~~)")
INLINE_CODE_RE = re.compile(r"`[^`\n]*`")


def markdown_files() -> list[Path]:
    files = [p for p in MARKDOWN_FILES if p.is_file()]
    for root in MARKDOWN_ROOTS:
        if root.is_dir():
            files.extend(sorted(root.rglob("*.md")))
    seen: set[Path] = set()
    result: list[Path] = []
    for path in files:
        resolved = path.resolve()
        if resolved not in seen:
            seen.add(resolved)
            result.append(path)
    return result


def strip_code(line: str) -> str:
    """Remove inline code spans so links inside them are not checked."""
    return INLINE_CODE_RE.sub("", line)


def check_file(path: Path) -> list[str]:
    errors: list[str] = []
    in_fence = False
    for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if FENCE_RE.match(raw):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        line = strip_code(raw)
        for match in LINK_RE.finditer(line):
            target = match.group(2).strip()
            if target.startswith("<") and target.endswith(">"):
                target = target[1:-1].strip()
            if not target:
                continue
            parts = urlsplit(target)
            if parts.scheme in {"http", "https", "mailto", "tel", "data"}:
                continue
            if target.startswith("#"):
                continue
            # Pure query/fragment links are not file links.
            if not parts.path:
                continue
            clean = unquote(parts.path)
            if clean.startswith("/"):
                dest = ROOT / clean.lstrip("/")
            else:
                dest = path.parent / clean
            dest = dest.resolve()
            try:
                exists = dest.exists()
            except OSError:
                exists = False
            if not exists:
                rel = path.relative_to(ROOT)
                errors.append(f"{rel}:{lineno}: missing local link target: {target}")
    return errors


def main() -> int:
    files = markdown_files()
    errors: list[str] = []
    for path in files:
        errors.extend(check_file(path))
    if errors:
        print("Broken local Markdown links:", file=sys.stderr)
        for error in errors:
            print(f"  {error}", file=sys.stderr)
        return 1
    print(f"OK: checked {len(files)} Markdown files; all local links resolve.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
