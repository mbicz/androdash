#!/usr/bin/env python3
"""Serve the AndroDash repository for browser development.

The Android shell serves web/app from a virtual origin; this server is the
browser equivalent. It serves the repository root so the demo dashboard fixture
and the renderer can be loaded together.

It also serves the provisioning directory under `/ignition/`: a phone launched
with `ignition_wait` polls `/ignition/<device code>.json`, and a missing file is
a 404 that keeps it waiting (decision 0027).

Usage:
    python3 tools/serve_demo.py --port 8099
    python3 tools/serve_demo.py --host 0.0.0.0 --port 8099
"""

from __future__ import annotations

import argparse
import functools
import json
import mimetypes
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

sys.path.insert(0, str(Path(__file__).resolve().parent))

from provisioning import (  # noqa: E402
    DEFAULT_DIR,
    QUERY_CODE,
    QUERY_IP,
    QUERY_MODEL,
    is_code,
    read_document,
    record_request,
)


ROOT = Path(__file__).resolve().parent.parent
PROVISIONING_DIR = DEFAULT_DIR

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/json", ".json")


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Accept, Content-Type")
        self.send_header("Cache-Control", "no-store")

    def end_headers(self) -> None:
        self._cors()
        super().end_headers()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path, _, query = self.path.partition("?")
        if path == "/":
            self.send_response(302)
            self.send_header("Location", "/web/app/index.html")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == "/ignition" or path.startswith("/ignition/"):
            self._serve_ignition(path, query)
            return
        super().do_GET()

    def _serve_ignition(self, path: str, query: str) -> None:
        """`/ignition/<code>.json` from the provisioning directory (decision 0027).

        A missing document is a plain 404 so the phone stays in its waiting
        state; every poll is recorded, including the identity parameters the
        shell appends, so `tools/provision.py pending` can list waiting codes.
        """
        code = path[len("/ignition"):].strip("/")
        if code.endswith(".json"):
            code = code[: -len(".json")]
        parameters = parse_qs(query)
        model = (parameters.get(QUERY_MODEL) or [""])[0]
        ip = (parameters.get(QUERY_IP) or [""])[0]
        if not is_code(code):
            # `/ignition` with no code, or with an identity parameter instead.
            code = (parameters.get(QUERY_CODE) or [""])[0]
        if not is_code(code):
            self.send_error(404, "Not found")
            return
        document = read_document(PROVISIONING_DIR, code)
        record_request(PROVISIONING_DIR, code, model=model, ip=ip, status=200 if document else 404)
        if document is None:
            self.send_error(404, f"no provisioning document for {code}")
            return
        body = json.dumps(document).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def list_directory(self, path: str | Path) -> None:
        # The demo server is not a browsing surface. Directory listings are off.
        self.send_error(404, "Not found")

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[serve] {self.address_string()} {fmt % args}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8099)
    parser.add_argument("--provisioning-dir", type=Path, default=DEFAULT_DIR,
                        help="directory of <code>.json provisioning documents")
    args = parser.parse_args()

    global PROVISIONING_DIR
    PROVISIONING_DIR = args.provisioning_dir

    handler = functools.partial(Handler, directory=str(ROOT))
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"demo server: http://{args.host}:{args.port}/")
    print(f"renderer:    http://{args.host}:{args.port}/web/app/index.html")
    print(f"dashboard:   http://{args.host}:{args.port}/contracts/fixtures/demo-dashboard.json")
    print(f"spark:       http://{args.host}:{args.port}/contracts/fixtures/spark-dashboard.json")
    print(f"ignition:    http://{args.host}:{args.port}/ignition/{'{device}'}.json "
          f"({PROVISIONING_DIR})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
