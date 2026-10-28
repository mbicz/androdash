#!/usr/bin/env python3
"""Serve the AndroDash repository for browser development.

The Android shell serves web/app from a virtual origin; this server is the
browser equivalent. It serves the repository root so the demo dashboard fixture
and the renderer can be loaded together.

Usage:
    python3 tools/serve_demo.py --port 8099
    python3 tools/serve_demo.py --host 0.0.0.0 --port 8099
"""

from __future__ import annotations

import argparse
import functools
import mimetypes
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent

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
        path = self.path.split("?", 1)[0]
        if path == "/":
            self.send_response(302)
            self.send_header("Location", "/web/app/index.html")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        super().do_GET()

    def list_directory(self, path: str | Path) -> None:
        # The demo server is not a browsing surface. Directory listings are off.
        self.send_error(404, "Not found")

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[serve] {self.address_string()} {fmt % args}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8099)
    args = parser.parse_args()

    handler = functools.partial(Handler, directory=str(ROOT))
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"demo server: http://{args.host}:{args.port}/")
    print(f"renderer:    http://{args.host}:{args.port}/web/app/index.html")
    print(f"dashboard:   http://{args.host}:{args.port}/contracts/fixtures/demo-dashboard.json")
    print(f"spark:       http://{args.host}:{args.port}/contracts/fixtures/spark-dashboard.json")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
