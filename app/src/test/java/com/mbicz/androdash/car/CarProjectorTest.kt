package com.mbicz.androdash.car

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * C-010 test obligations: which panels project, which are omitted, the omission
 * counts, tab assignment, and no fabricated data.
 */
class CarProjectorTest {
    private fun fixture(name: String): JSONObject =
        JSONObject(File("../contracts/fixtures/$name").readText())

    private fun fleet(): JSONObject = fixture("inference-fleet-dashboard.json")

    @Test
    fun `charts without range data are counted as omitted`() {
        val view = CarProjector.project(fleet(), emptyMap())
        // The fleet fixture has 3 TimeSeriesChart panels and no Markdown; with no
        // series they contribute no sparklines, so they are counted as omitted.
        assertEquals(3, view.omittedCharts)
        assertEquals(0, view.omittedText)
    }

    @Test
    fun `charts with range data become sparkline rows`() {
        val series = mapOf(
            "throughput" to listOf(
                CarProjector.Series(mapOf("instance" to "gx10-5cc5"), listOf(1.0, 2.0, 4.0, 8.0)),
            ),
            "power" to listOf(
                CarProjector.Series(mapOf("instance" to "gx10-5cc5"), listOf(5.0, 5.0, 5.0)),
            ),
        )
        val view = CarProjector.project(fleet(), series)
        val rows = view.tabs.flatMap { it.rows }.filter { it.spark != null }

        assertTrue("charts produce sparkline rows", rows.isNotEmpty())
        assertTrue(
            "sparklines are fixed width",
            rows.all { it.spark!!.length == CarProjector.SPARK_WIDTH },
        )
        assertTrue(
            "sparklines use block characters only",
            rows.all { row -> row.spark!!.all { it in CarProjector.SPARK } },
        )
        assertEquals("charts are no longer omitted", 1, view.omittedCharts)
    }

    @Test
    fun `sparkline shows rising data and does not collapse a flat series`() {
        val rising = CarProjector.sparkline(listOf(1.0, 2.0, 3.0, 4.0), width = 4)!!
        assertEquals("▁▃▅█", rising)

        val flat = CarProjector.sparkline(listOf(7.0, 7.0, 7.0, 7.0), width = 4)!!
        assertEquals("▅▅▅▅", flat)

        assertEquals(null, CarProjector.sparkline(emptyList()))
    }

    @Test
    fun `sparkline keeps its shape over a long range`() {
        val values = (0 until 100).map { it.toDouble() }
        val spark = CarProjector.sparkline(values, width = 24)!!
        assertEquals(24, spark.length)
        assertTrue("starts low", spark.first() == CarProjector.SPARK.first())
        assertTrue("ends high", spark.last() == CarProjector.SPARK.last())
    }

    @Test
    fun `demo dashboard counts its markdown panel`() {
        val view = CarProjector.project(fixture("demo-dashboard.json"), emptyMap())
        assertTrue("demo has a Markdown panel", view.omittedText >= 1)
    }

    @Test
    fun `absent series render as an em dash and are never zero`() {
        val view = CarProjector.project(fleet(), emptyMap())
        val rows = view.tabs.flatMap { it.rows }
        assertTrue("value rows are produced even without samples", rows.isNotEmpty())
        assertTrue("every row has the no-data marker", rows.all { it.value == "—" })
        assertTrue("every row is labelled No data", rows.all { it.state == "No data" })
    }

    @Test
    fun `stat panel projects one row per series with its threshold state`() {
        val series = mapOf(
            "hosts" to listOf(
                CarProjector.Series(mapOf("instance" to "gx10-5cc5"), listOf(1.0)),
                CarProjector.Series(mapOf("instance" to "gx10-e185"), listOf(0.0)),
            ),
        )
        val view = CarProjector.project(fleet(), series)
        val rows = view.tabs.flatMap { it.rows }
        val hosts = rows.filter { it.label.contains("Inference hosts") }

        assertEquals(2, hosts.size)
        assertTrue("labels name the instance", hosts.any { it.label.startsWith("gx10-5cc5") })
        // Threshold steps: one step at 1.0 named "Up" → >= 1 is critical, below is nominal.
        assertEquals("Up", hosts.first { it.label.startsWith("gx10-5cc5") }.state)
        assertEquals("Nominal", hosts.first { it.label.startsWith("gx10-e185") }.state)
    }

    @Test
    fun `values format exactly as C-005 does`() {
        val format = JSONObject("""{"unit":"percent","decimalPlaces":0}""")
        assertEquals("42%", CarProjector.formatValue(42.0, format))
        assertEquals("—", CarProjector.formatValue(null, format))

        val tokens = JSONObject("""{"unit":"tokens","decimalPlaces":1}""")
        assertEquals("1.5K tok/s", CarProjector.formatValue(1500.0, tokens))

        val celsius = JSONObject("""{"unit":"celsius","decimalPlaces":0}""")
        assertEquals("61 °C", CarProjector.formatValue(61.4, celsius))
    }

    @Test
    fun `calculation modes match the renderer`() {
        val values = listOf(1.0, 5.0, 3.0)
        assertEquals(3.0, CarProjector.calculation(values, "last-number")!!, 0.0)
        assertEquals(1.0, CarProjector.calculation(values, "first-number")!!, 0.0)
        assertEquals(3.0, CarProjector.calculation(values, "mean")!!, 0.0)
        assertEquals(9.0, CarProjector.calculation(values, "sum")!!, 0.0)
        assertEquals(1.0, CarProjector.calculation(values, "min")!!, 0.0)
        assertEquals(5.0, CarProjector.calculation(values, "max")!!, 0.0)
        assertEquals(3.0, CarProjector.calculation(values, "count")!!, 0.0)
        assertEquals(null, CarProjector.calculation(emptyList(), "last-number"))
    }

    @Test
    fun `tabs never exceed four and overflow is reported`() {
        val series = HashMap<String, List<CarProjector.Series>>()
        val panels = fleet().getJSONObject("spec").getJSONObject("panels")
        for (id in panels.keys()) {
            series[id] = (1..40).map {
                CarProjector.Series(mapOf("instance" to "host$it"), listOf(1.0))
            }
        }
        val view = CarProjector.project(fleet(), series)

        assertTrue("at least two tabs", view.tabs.size >= CarProjector.MIN_TABS)
        assertTrue("at most four tabs", view.tabs.size <= CarProjector.MAX_TABS)
        assertTrue("every tab respects the row cap", view.tabs.all { it.rows.size <= CarProjector.MAX_ROWS_PER_TAB })
        assertTrue("overflow is counted, not dropped", view.omittedRows > 0)
    }

    @Test
    fun `reading order follows the layout rows`() {
        val dashboard = JSONObject(
            """
            {
              "spec": {
                "panels": {
                  "second": {"spec": {"display": {"name": "Second"}, "plugin": {"kind": "StatChart"}}},
                  "first":  {"spec": {"display": {"name": "First"},  "plugin": {"kind": "StatChart"}}}
                },
                "layouts": [
                  {"kind": "Grid", "spec": {"items": [
                    {"x": 0, "y": 0, "width": 12, "height": 4, "content": {"${'$'}ref": "#/spec/panels/first"}},
                    {"x": 12, "y": 0, "width": 12, "height": 4, "content": {"${'$'}ref": "#/spec/panels/second"}}
                  ]}}
                ]
              }
            }
            """.trimIndent(),
        )
        val series = mapOf(
            "first" to listOf(CarProjector.Series(emptyMap(), listOf(1.0))),
            "second" to listOf(CarProjector.Series(emptyMap(), listOf(2.0))),
        )
        val view = CarProjector.project(dashboard, series)
        val rows = view.tabs.flatMap { it.rows }
        assertEquals(listOf("First", "Second"), rows.map { it.label })
    }

    @Test
    fun `stale is carried to every row`() {
        val series = mapOf(
            "hosts" to listOf(CarProjector.Series(mapOf("instance" to "h"), listOf(1.0))),
        )
        val view = CarProjector.project(fleet(), series, stale = true)
        val rows = view.tabs.flatMap { it.rows }
        assertNotNull(rows)
        assertTrue("rows carry the stale flag", rows.all { it.stale })
    }
}
