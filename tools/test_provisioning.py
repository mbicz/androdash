"""Checks for the provisioning convention (`tools/provisioning.py`).

Run from the repository root:

    python3 -m unittest discover -s tools -p 'test_*.py' -v

The invariants: a device code is six digits and can never become a path, a
written document passes the C-001 rules the shell enforces, a missing document
reads as "not provisioned" rather than an error, and the request log lists
exactly the codes still waiting.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from provisioning import (
    ProvisioningError,
    clear_document,
    document_path,
    is_code,
    read_document,
    record_request,
    served,
    waiting,
    write_document,
)

DOCUMENT = {
    "schemaVersion": 1,
    "dashboards": {
        "urls": ["http://androdash.local/dashboards/phone-dashboard.json"],
        "current": "http://androdash.local/dashboards/phone-dashboard.json",
    },
    "collector": {"enabled": True, "targets": "node:mac=192.168.1.20:9100"},
}


class CodeTest(unittest.TestCase):
    def test_six_digits_only(self):
        self.assertTrue(is_code("100000"))
        self.assertTrue(is_code("999999"))
        for bad in ["", None, "12345", "1234567", "12345a", " 123456", "../x", "123456/"]:
            self.assertFalse(is_code(bad), bad)

    def test_code_cannot_escape_the_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for bad in ["../etc/passwd", "1234567", "abcdef"]:
                with self.assertRaises(ProvisioningError):
                    document_path(root, bad)
            self.assertEqual(document_path(root, "482913"), root / "482913.json")


class DocumentTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_missing_document_reads_as_not_provisioned(self):
        self.assertIsNone(read_document(self.root, "482913"))

    def test_write_then_read_round_trips(self):
        path = write_document(self.root, "482913", DOCUMENT)
        self.assertEqual(path, self.root / "482913.json")
        self.assertEqual(read_document(self.root, "482913"), DOCUMENT)

    def test_invalid_document_is_rejected_and_not_written(self):
        bad = {"dashboards": {"urls": ["ftp://x/y.json"]}}
        with self.assertRaises(ProvisioningError):
            write_document(self.root, "482913", bad)
        self.assertFalse((self.root / "482913.json").exists())

    def test_unknown_key_is_rejected(self):
        with self.assertRaises(ProvisioningError):
            write_document(self.root, "482913", {**DOCUMENT, "secret": 1})

    def test_clear_is_idempotent(self):
        write_document(self.root, "482913", DOCUMENT)
        self.assertTrue(clear_document(self.root, "482913"))
        self.assertFalse(clear_document(self.root, "482913"))
        self.assertIsNone(read_document(self.root, "482913"))

    def test_served_lists_only_codes(self):
        write_document(self.root, "482913", DOCUMENT)
        write_document(self.root, "100001", DOCUMENT)
        (self.root / "requests.jsonl").write_text("", encoding="utf-8")
        (self.root / "notes.json").write_text("{}", encoding="utf-8")
        self.assertEqual(sorted(served(self.root)), ["100001", "482913"])


class WaitingTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_polls_without_a_document_are_waiting(self):
        record_request(self.root, "482913", model="Pixel 4a (5G)", ip="192.168.1.50")
        record_request(self.root, "482913", model="Pixel 4a (5G)", ip="192.168.1.50")
        record_request(self.root, "100001", model="Pixel 10", ip="192.168.1.51")
        entries = waiting(self.root)
        self.assertEqual([entry.code for entry in entries], ["100001", "482913"])
        by_code = {entry.code: entry for entry in entries}
        self.assertEqual(by_code["482913"].polls, 2)
        self.assertEqual(by_code["482913"].model, "Pixel 4a (5G)")
        self.assertEqual(by_code["482913"].ip, "192.168.1.50")

    def test_a_served_code_stops_waiting(self):
        record_request(self.root, "482913", ip="192.168.1.50")
        write_document(self.root, "482913", DOCUMENT)
        self.assertEqual(waiting(self.root), [])
        self.assertEqual(served(self.root), ["482913"])

    def test_invalid_codes_and_noise_are_ignored(self):
        (self.root).mkdir(parents=True, exist_ok=True)
        (self.root / "requests.jsonl").write_text(
            '{"code": "12", "at": "2026-11-01T00:00:00+00:00"}\nnot json\n'
            '{"code": "482913", "at": "2026-11-01T00:00:00+00:00"}\n',
            encoding="utf-8",
        )
        self.assertEqual([entry.code for entry in waiting(self.root)], ["482913"])

    def test_log_is_bounded(self):
        for index in range(520):
            record_request(self.root, "482913", ip=f"192.168.1.{index % 250}")
        lines = (self.root / "requests.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 500)
        self.assertEqual(json.loads(lines[-1])["ip"], "192.168.1.19")


if __name__ == "__main__":
    unittest.main()
