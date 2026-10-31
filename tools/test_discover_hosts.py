"""Checks for the host discovery tool (`tools/discover_hosts.py`).

Run from the repository root:

    python3 -m unittest discover -s tools -p 'test_*.py' -v

The invariants: identity and classification come from the `/metrics` text (no
guesses), the Ignition document satisfies the C-001 rules the Android shell
enforces, and the phone dashboard is always first so a freshly seeded device has
data before any LAN exporter answers.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from discover_hosts import (
    PHONE_DASHBOARD,
    Exporter,
    Report,
    classify,
    ignition_document,
    metric_identity,
    parse_arp,
    parse_prometheus_targets,
    parse_tailscale,
    validate_ignition,
)

ROOT = Path(__file__).resolve().parent.parent
DASHBOARDS = ROOT / "contracts" / "fixtures"


def node_metrics(nodename: str = "mike", sysname: str = "Darwin") -> str:
    return (
        "# HELP node_uname_info Labeled system information.\n"
        "# TYPE node_uname_info gauge\n"
        f'node_uname_info{{domainname="internal",machine="arm64",nodename="{nodename}",'
        f'release="25.3.0",sysname="{sysname}"}} 1\n'
        "node_load1 0.4\n"
    )


def spark_metrics() -> str:
    return 'spark_collector_success{collector="nvidia"} 1\nspark_gpu_power_watts{gpu="0"} 61\n'


def agent_metrics() -> str:
    return "agent_sessions_active{harness=\"claude\"} 2\n"


def demo_metrics() -> str:
    return "demo_load1 1.2\n"


class ParseTest(unittest.TestCase):
    def test_arp_addresses_ignore_incomplete_and_multicast(self) -> None:
        text = (
            "? (192.168.192.16) at d0:11:e5:cf:9c:fb on en0 ifscope [ethernet]\n"
            "? (192.168.192.40) at (incomplete) on en0 ifscope [ethernet]\n"
            "? (224.0.0.251) at 1:0:5e:0:0:fb on en0 ifscope permanent [ethernet]\n"
            "? (192.168.192.50) at 12:34:56:78:9a:bc [ether] on wlan0\n"
        )
        self.assertEqual(parse_arp(text), ["192.168.192.16", "192.168.192.50"])

    def test_tailscale_addresses(self) -> None:
        text = (
            "100.67.100.65   mike           michal@         macOS    -\n"
            "100.87.99.90    gx10-5cc5      michal@         linux    active; direct\n"
        )
        self.assertEqual(parse_tailscale(text), ["100.67.100.65", "100.87.99.90"])

    def test_prometheus_targets_drop_loopback(self) -> None:
        text = json.dumps({"data": {"activeTargets": [
            {"scrapeUrl": "http://192.168.192.16:9100/metrics"},
            {"scrapeUrl": "http://localhost:9090/metrics"},
            {"scrapeUrl": "http://192.168.192.16:9106/metrics"},
        ]}})
        self.assertEqual(parse_prometheus_targets(text), ["192.168.192.16"])

    def test_prometheus_targets_reject_junk(self) -> None:
        self.assertEqual(parse_prometheus_targets("not json"), [])

    def test_identity_comes_from_node_uname_info(self) -> None:
        self.assertEqual(metric_identity(node_metrics("gx10-5cc5", "Linux")), ("gx10-5cc5", "Linux"))
        self.assertEqual(metric_identity("node_load1 1\n"), (None, None))


class ClassifyTest(unittest.TestCase):
    def test_node_exporter_only_counts_on_darwin(self) -> None:
        # The macOS dashboard reads Darwin-only node_exporter families.
        self.assertIsNotNone(classify("192.168.192.16", 9100, node_metrics(), "host"))
        self.assertIsNone(classify("192.168.192.16", 9100, node_metrics(sysname="Linux"), "host"))

    def test_exporter_kinds_are_recognised_by_their_families(self) -> None:
        spark = classify("100.87.99.90", 9400, spark_metrics(), "tailnet")
        self.assertEqual((spark.job, spark.dashboard), ("spark", "spark-dashboard.json"))
        self.assertEqual(classify("192.168.192.16", 9106, agent_metrics(), "host").job, "agenticmac")
        self.assertEqual(classify("192.168.192.16", 9091, demo_metrics(), "host").job, "demo")

    def test_foreign_metrics_are_not_claimed(self) -> None:
        self.assertIsNone(classify("192.168.192.16", 9106, node_metrics(), "host"))
        self.assertIsNone(classify("192.168.192.16", 9091, "# only comments\n", "host"))


class IgnitionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.report = Report(exporters=[
            Exporter("192.168.192.16", 9100, "node", "macos-node-dashboard.json", "mike", "Darwin"),
            Exporter("192.168.192.16", 9106, "agenticmac", "agenticmac-dashboard.json", "mike"),
            Exporter("192.168.192.16", 9091, "demo", "demo-dashboard.json", "mike"),
        ])

    def test_phone_dashboard_comes_first_and_is_current(self) -> None:
        doc = ignition_document(self.report)
        urls = doc["dashboards"]["urls"]
        self.assertEqual(urls[0], PHONE_DASHBOARD)
        self.assertEqual(doc["dashboards"]["current"], PHONE_DASHBOARD)
        self.assertEqual(urls, [
            PHONE_DASHBOARD,
            "http://androdash.local/dashboards/macos-node-dashboard.json",
            "http://androdash.local/dashboards/agenticmac-dashboard.json",
            "http://androdash.local/dashboards/demo-dashboard.json",
        ])

    def test_targets_are_canonical_and_keep_the_phone_job_implicit(self) -> None:
        doc = ignition_document(self.report)
        self.assertTrue(doc["collector"]["enabled"])
        self.assertTrue(doc["collector"]["phone"])
        self.assertEqual(
            doc["collector"]["targets"],
            "node:mike=192.168.192.16:9100,agenticmac:mike=192.168.192.16:9106,demo:mike=192.168.192.16:9091",
        )
        self.assertEqual(validate_ignition(doc), [])

    def test_dashboard_cap_and_duplicate_targets(self) -> None:
        exporters = [
            Exporter("192.168.192.16", 9100 + index, "node", "macos-node-dashboard.json", "mike")
            for index in range(10)
        ]
        doc = ignition_document(Report(exporters=exporters))
        self.assertLessEqual(len(doc["dashboards"]["urls"]), 8)
        # Same job and instance repeated: the target list keeps the first only.
        self.assertEqual(doc["collector"]["targets"], "node:mike=192.168.192.16:9100")

    def test_every_dashboard_url_names_a_bundled_fixture(self) -> None:
        doc = ignition_document(self.report)
        for url in doc["dashboards"]["urls"]:
            name = url.rsplit("/", 1)[-1]
            self.assertTrue((DASHBOARDS / name).is_file(), url)

    def test_validator_matches_the_shell_rules(self) -> None:
        good = ignition_document(self.report)
        self.assertEqual(validate_ignition(good), [])
        broken = json.loads(json.dumps(good))
        broken["unknown"] = 1
        broken["dashboards"]["current"] = "http://androdash.local/dashboards/nope.json"
        broken["collector"]["targets"] = "node:mike=192.168.192.16:9100,node:mike=192.168.192.16:9100"
        problems = validate_ignition(broken)
        self.assertTrue(any("unknown key" in problem for problem in problems), problems)
        self.assertTrue(any("dashboards.current" in problem for problem in problems), problems)
        self.assertTrue(any("repeats a job and instance" in problem for problem in problems), problems)

    def test_collector_without_any_target_is_rejected(self) -> None:
        doc = {
            "schemaVersion": 1,
            "dashboards": {"urls": [PHONE_DASHBOARD]},
            "collector": {"enabled": True, "phone": False, "targets": ""},
        }
        self.assertEqual(len(validate_ignition(doc)), 1)


if __name__ == "__main__":
    unittest.main()
