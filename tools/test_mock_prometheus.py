"""Integration checks for the deterministic Prometheus mock.

Run from the repository root:

    python3 -m unittest discover -s tools -p 'test_*.py' -v

The important invariant is that every query in the Spark dashboard fixture is
recognized by the mock, so the demo cannot silently show an empty panel because
the fixture and mock drifted apart.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from mock_prometheus import _instant_result, _range_result


ROOT = Path(__file__).resolve().parent.parent
DASHBOARD = ROOT / "contracts" / "fixtures" / "spark-dashboard.json"
NOW = 1_700_000_000.0


class SparkDashboardMockTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.dashboard = json.loads(DASHBOARD.read_text(encoding="utf-8"))

    def panels(self):
        return self.dashboard["spec"]["panels"].items()

    def test_every_dashboard_query_has_demo_data(self) -> None:
        queries = 0
        for panel_id, panel in self.panels():
            kind = panel["spec"]["plugin"]["kind"]
            if kind == "Markdown":
                continue
            for query in panel["spec"]["queries"]:
                spec = query["spec"]["plugin"]["spec"]
                promql = spec["query"]
                queries += 1
                result = (
                    _instant_result(promql, NOW)
                    if kind == "Table"
                    else _range_result(promql, NOW - 900, NOW, 15)
                )
                self.assertIsNotNone(result, f"{panel_id}: mock does not recognize {promql}")
                self.assertTrue(result, f"{panel_id}: mock returned no series for {promql}")
                for series in result:
                    self.assertEqual(series["metric"].get("job"), "spark")

        self.assertGreaterEqual(queries, 23)

    def test_arithmetic_queries_return_display_units(self) -> None:
        panels = self.dashboard["spec"]["panels"]

        def last(panel_id: str, query_index: int = 0) -> float:
            spec = panels[panel_id]["spec"]["queries"][query_index]["spec"]["plugin"]["spec"]
            result = _range_result(spec["query"], NOW - 60, NOW, 15)
            self.assertIsNotNone(result)
            return float(result[0]["values"][-1][1])

        self.assertGreater(last("gpu-utilization"), 10.0)
        self.assertLessEqual(last("gpu-utilization"), 100.0)
        self.assertGreater(last("kv-cache"), 10.0)
        self.assertLessEqual(last("kv-cache"), 100.0)
        self.assertGreater(last("token-latency"), 100.0)
        self.assertGreater(last("token-latency", 1), 1.0)
        self.assertGreater(last("rdma-traffic"), 1e9)

    def test_grouped_panels_share_one_unit(self) -> None:
        """Every query in a grouped panel must resolve to the same display unit."""
        panels = self.dashboard["spec"]["panels"]
        expected = {
            "thermal": "celsius",
            "power": "watts",
            "clocks": "hertz",
            "requests": "short",
        }
        for panel_id, unit in expected.items():
            spec = panels[panel_id]["spec"]["plugin"]["spec"]
            self.assertEqual(spec["format"]["unit"], unit, panel_id)
            queries = panels[panel_id]["spec"]["queries"]
            self.assertGreaterEqual(len(queries), 2, panel_id)
            for query in queries:
                promql = query["spec"]["plugin"]["spec"]["query"]
                result = _range_result(promql, NOW - 60, NOW, 15)
                self.assertIsNotNone(result, f"{panel_id}: {promql}")
                self.assertTrue(result, f"{panel_id}: {promql}")

    def test_missing_driver_fields_are_absent_not_zero(self) -> None:
        self.assertIsNone(_range_result("spark_gpu_memory_total_bytes", NOW - 10, NOW, 1))
        self.assertIsNone(
            _range_result("spark_gpu_field_supported{field=\"memory_total_bytes\"}", NOW - 10, NOW, 1)
        )

    def test_collector_health_is_a_table_vector(self) -> None:
        result = _instant_result("spark_collector_success", NOW)
        self.assertIsNotNone(result)
        self.assertEqual(len(result), 7)
        self.assertTrue(all(item["value"][1] == "1" for item in result))

    def test_unknown_query_still_fails(self) -> None:
        self.assertIsNone(_range_result("sum(not_a_metric)", NOW - 10, NOW, 1))


if __name__ == "__main__":
    unittest.main()
