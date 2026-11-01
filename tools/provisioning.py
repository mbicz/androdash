#!/usr/bin/env python3
"""The provisioning file convention an AndroDash phone polls (decision 0027).

A phone launched with `ignition_wait` presents its six-digit device code and
fetches `<provisioning base>/ignition/<code>.json` every `ignition_wait_seconds`
until a document exists. This module is the server side of that convention: a
directory of `<code>.json` Ignition documents, plus a request log so an operator
can see which codes are waiting.

The directory is `provisioning/` at the repository root by default. The demo
server (`tools/serve_demo.py`) serves it under `/ignition/`; the CLI
(`tools/provision.py`) lists waiting codes and writes documents.

Nothing here contacts a phone: the phone polls, the server answers. That keeps
C-008 (no LAN listener on the phone) intact.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from discover_hosts import validate_ignition

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DIR = ROOT / "provisioning"

#: The six-digit code the app generates (C-001 decision 0027).
CODE = re.compile(r"[0-9]{6}")

#: Identity query parameters the shell appends.
QUERY_CODE = "device_code"
QUERY_MODEL = "device_model"
QUERY_IP = "device_ip"

REQUESTS_FILE = "requests.jsonl"


class ProvisioningError(ValueError):
    """A code, path, or document that violates the convention."""


def is_code(value: str | None) -> bool:
    return bool(value) and CODE.fullmatch(value) is not None


def document_path(root: Path, code: str) -> Path:
    """`<root>/<code>.json`; the code is validated so it can never be a path."""
    if not is_code(code):
        raise ProvisioningError(f"device code must be six digits, not {code!r}")
    return root / f"{code}.json"


def read_document(root: Path, code: str) -> dict | None:
    path = document_path(root, code)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError):
        return None


def write_document(root: Path, code: str, document: dict) -> Path:
    """Validate [document] with the shell's rules, then write it atomically."""
    problems = validate_ignition(document)
    if problems:
        raise ProvisioningError("; ".join(problems))
    path = document_path(root, code)
    root.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=str(root), prefix=f".{code}.", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(document, stream, indent=2)
            stream.write("\n")
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
    return path


def clear_document(root: Path, code: str) -> bool:
    """Delete the document so the phone returns to the waiting state."""
    path = document_path(root, code)
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False


def record_request(root: Path, code: str, model: str = "", ip: str = "", status: int = 404) -> None:
    """Append one poll to `<root>/requests.jsonl` (bounded to the last 500 lines)."""
    root.mkdir(parents=True, exist_ok=True)
    line = json.dumps({
        "at": datetime.now(timezone.utc).isoformat(timespec="microseconds"),
        "code": code,
        "model": model,
        "ip": ip,
        "status": status,
    }, sort_keys=True)
    path = root / REQUESTS_FILE
    with path.open("a", encoding="utf-8") as stream:
        stream.write(line + "\n")
    _trim(path, 500)


def _trim(path: Path, limit: int) -> None:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    if len(lines) <= limit:
        return
    path.write_text("\n".join(lines[-limit:]) + "\n", encoding="utf-8")


@dataclass(frozen=True)
class Waiting:
    """One code that asked for a document and has none yet."""

    code: str
    model: str
    ip: str
    last_seen: str
    polls: int


def waiting(root: Path) -> list[Waiting]:
    """Codes with at least one poll and no document, newest activity first."""
    path = root / REQUESTS_FILE
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    seen: dict[str, Waiting] = {}
    for line in lines:
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        code = entry.get("code")
        if not is_code(code):
            continue
        previous = seen.get(code)
        seen[code] = Waiting(
            code=code,
            model=entry.get("model") or (previous.model if previous else ""),
            ip=entry.get("ip") or (previous.ip if previous else ""),
            last_seen=entry.get("at") or "",
            polls=(previous.polls if previous else 0) + 1,
        )
    return sorted(
        (entry for entry in seen.values() if not document_path(root, entry.code).is_file()),
        key=lambda entry: entry.last_seen,
        reverse=True,
    )


def served(root: Path) -> Iterable[str]:
    """Codes that currently have a document."""
    try:
        entries = sorted(root.glob("*.json"))
    except OSError:
        return []
    return [entry.stem for entry in entries if is_code(entry.stem)]
