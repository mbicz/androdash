#!/usr/bin/env python3
"""Provision AndroDash phones from the repository (decision 0027).

A phone launched with `ignition_wait` shows its six-digit device code and polls
`<base>/ignition/<code>.json` until a document exists. This CLI is the operator
side: it lists the codes that are waiting, writes a document for one of them, and
clears it again.

Usage:

    python3 tools/provision.py pending
    python3 tools/provision.py write 482913 /tmp/ignition.json
    python3 tools/provision.py show 482913
    python3 tools/provision.py clear 482913

The directory is `provisioning/` unless `--dir` says otherwise; serve it with
`python3 tools/serve_demo.py --host 0.0.0.0 --port 8099`, which answers
`/ignition/<code>.json` and records every poll.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from provisioning import (
    DEFAULT_DIR,
    ProvisioningError,
    clear_document,
    document_path,
    read_document,
    served,
    waiting,
    write_document,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dir", type=Path, default=DEFAULT_DIR, help="provisioning directory")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("pending", help="codes waiting for a document, newest first")
    sub.add_parser("served", help="codes that already have a document")

    write = sub.add_parser("write", help="store a validated document for one code")
    write.add_argument("code")
    write.add_argument("document", type=Path, help="Ignition JSON file, or - for stdin")

    show = sub.add_parser("show", help="print the document for one code")
    show.add_argument("code")

    clear = sub.add_parser("clear", help="delete the document for one code")
    clear.add_argument("code")

    args = parser.parse_args(argv)

    try:
        if args.command == "pending":
            entries = waiting(args.dir)
            if not entries:
                print("no code is waiting (no polls recorded in "
                      f"{args.dir / 'requests.jsonl'})")
                return 0
            for entry in entries:
                print(f"{entry.code}  {entry.last_seen}  polls={entry.polls:<3} "
                      f"model={entry.model or '?'} ip={entry.ip or '?'}")
            return 0
        if args.command == "served":
            codes = served(args.dir)
            print("\n".join(codes) if codes else "no documents")
            return 0
        if args.command == "write":
            text = sys.stdin.read() if str(args.document) == "-" else args.document.read_text(encoding="utf-8")
            document = json.loads(text)
            if not isinstance(document, dict):
                print("the document must be one JSON object", file=sys.stderr)
                return 1
            path = write_document(args.dir, args.code, document)
            print(f"wrote {path}")
            return 0
        if args.command == "show":
            document = read_document(args.dir, args.code)
            if document is None:
                print(f"{args.code} has no document", file=sys.stderr)
                return 1
            print(json.dumps(document, indent=2))
            return 0
        if args.command == "clear":
            removed = clear_document(args.dir, args.code)
            print(f"{'cleared' if removed else 'nothing to clear for'} {args.code}")
            return 0
    except ProvisioningError as error:
        print(f"provision: {error}", file=sys.stderr)
        return 1
    except (OSError, json.JSONDecodeError) as error:
        print(f"provision: {error}", file=sys.stderr)
        return 1
    except KeyError:
        print(f"provision: {document_path(args.dir, args.code)} is unreadable", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
