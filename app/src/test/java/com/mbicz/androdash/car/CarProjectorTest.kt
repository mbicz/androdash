package com.mbicz.androdash.car

import java.io.File
import kotlin.math.roundToInt
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * C-010 test obligations: which panels project, which are omitted, the omission
 * counts, tab assignment, no fabricated data, and the braille raster.
 */
class CarProjectorTest {
    private fun fixture(name: String): JSONObject =
        JSONObject(File("../contracts/fixtures/$name").readText())

    private fun fleet(): JSONObject = fixture("inference-fleet-dashboard.json")

    @Test
    fun `charts without range data are counted as omitted`() {
        val view = CarProjector.project(fleet(), emptyMap())
        // The fleet fixture has 3 TimeSeriesChart panels and no Markdown; with no
        // series they contribute no raster, so they are counted as omitted.
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
            "sparkline is fixed width",
            rows.all { it.spark!!.length == CarProjector.SPARK_WIDTH },
        )
        assertTrue(
            "sparkline uses blocks only (a space would break alignment)",
            rows.all { row -> row.spark!!.all { it in CarProjector.SPARK } },
        )
        assertEquals("charts are no longer omitted", 1, view.omittedCharts)
    }

    @Test
    fun `sparkline never emits a space or empty cell`() {
        // Regression: spaces advance 8.00 px while blocks advance 23.00 px, so a
        // blank shifted every following cell and the row drifted left.
        for (values in listOf(
            listOf(1.0, 2.0, 3.0),
            listOf(1.0, 1.0, 1.0),
            List(100) { it.toDouble() },
        )) {
            val spark = CarProjector.sparkline(values)!!
            assertTrue("no spaces in $spark", spark.none { it == ' ' })
            assertTrue("all blocks in $spark", spark.all { it in CarProjector.SPARK })
            assertEquals(CarProjector.SPARK_WIDTH, spark.length)
        }
    }

    @Test
    fun `sparkline shows rising data and keeps a flat series mid-height`() {
        val rising = CarProjector.sparkline(listOf(1.0, 2.0, 3.0, 4.0), width = 4)!!
        assertEquals("\u2581\u2583\u2585\u2588", rising)

        val flat = CarProjector.sparkline(listOf(7.0, 7.0, 7.0, 7.0), width = 4)!!
        assertEquals("\u2585\u2585\u2585\u2585", flat)

        assertEquals(null, CarProjector.sparkline(emptyList()))
    }

    @Test
    fun `sparkline keeps its shape over a long range`() {
        val spark = CarProjector.sparkline((0 until 100).map { it.toDouble() }, width = 24)!!
        assertEquals(24, spark.length)
        assertEquals(CarProjector.SPARK.first(), spark.first())
        assertEquals(CarProjector.SPARK.last(), spark.last())
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
        assertTrue("rows carry the stale flag", rows.all { it.stale })
    }

    @Test
    fun `meter bars are fixed width and encode the value`() {
        // A fixed-width bar is the only way to get a constant right edge: the
        // car font is proportional, so a padded text column would drift.
        val empty = CarProjector.meter(0.0)!!
        val half = CarProjector.meter(50.0)!!
        val full = CarProjector.meter(100.0)!!

        assertEquals(CarProjector.BAR_WIDTH, empty.length)
        assertEquals(CarProjector.BAR_WIDTH, half.length)
        assertEquals(CarProjector.BAR_WIDTH, full.length)

        assertTrue("0% is all track", empty.all { it == CarProjector.BAR_TRACK })
        assertTrue("100% is all fill", full.all { it == CarProjector.BAR_FILL })
        assertEquals(
            "50% fills half the cells, rounded",
            (CarProjector.BAR_WIDTH / 2.0).roundToInt(),
            half.count { it == CarProjector.BAR_FILL },
        )
        assertTrue(
            "a bar never contains a space (8 px vs 17 px would drift)",
            listOf(empty, half, full).all { bar -> bar.none { it == ' ' } },
        )
    }

    @Test
    fun `meter clamps out-of-range values and rejects absent data`() {
        assertTrue(CarProjector.meter(-40.0)!!.all { it == CarProjector.BAR_TRACK })
        assertTrue(CarProjector.meter(150.0)!!.all { it == CarProjector.BAR_FILL })
        assertEquals(null, CarProjector.meter(null))
        assertEquals(null, CarProjector.meter(Double.NaN))
    }

    @Test
    fun `only percent panels get a meter bar`() {
        val series = mapOf(
            "gpu-utilization" to listOf(
                CarProjector.Series(mapOf("instance" to "gx10-5cc5"), listOf(58.0)),
            ),
            "temperatures" to listOf(
                CarProjector.Series(mapOf("instance" to "gx10-5cc5"), listOf(52.0)),
            ),
        )
        val view = CarProjector.project(fleet(), series)
        val rows = view.tabs.flatMap { it.rows }

        val gpu = rows.first { it.label.contains("GPU") }
        val temp = rows.first { it.label.contains("Temperatures") }

        assertTrue("a percent value has a real 0..100 scale", gpu.meter != null)
        // Celsius has no maximum in the dashboard, so a bar would invent one.
        assertEquals("a celsius value must not get a fabricated scale", null, temp.meter)
    }

    @Test
    fun `every row has at most one shape, so the row stays within two lines`() {
        val series = mapOf(
            "gpu-utilization" to listOf(
                CarProjector.Series(mapOf("instance" to "gx10-5cc5"), listOf(58.0)),
            ),
            "throughput" to listOf(
                CarProjector.Series(mapOf("instance" to "gx10-5cc5"), listOf(1.0, 2.0, 3.0)),
            ),
        )
        val view = CarProjector.project(fleet(), series)
        val rows = view.tabs.flatMap { it.rows }
        assertTrue(
            "a row carries a sparkline or a meter, never both",
            rows.all { it.spark == null || it.meter == null },
        )
    }

    @Test
    fun `severity orders states for a stable sort`() {
        assertEquals(0, CarProjector.severity("Nominal"))
        assertEquals(1, CarProjector.severity("No data"))
        assertEquals(2, CarProjector.severity("Warning"))
        assertEquals(3, CarProjector.severity("Critical"))
    }

    @Test
    fun `severity follows the breach, not the threshold name`() {
        // Dashboards name their thresholds freely ("Busy", "Tight", "Hot"). A
        // name-keyed colour map would paint a breached row green, so severity
        // must come from which threshold the value crossed.
        val steps = org.json.JSONArray(
            """[{"value":85,"name":"Busy"},{"value":95,"name":"Saturated"}]""",
        )
        assertEquals("below every threshold is nominal", 0, CarProjector.severityFor(50.0, steps))
        assertEquals("crossing the lower threshold is a warning", 2, CarProjector.severityFor(90.0, steps))
        assertEquals("crossing the highest threshold is critical", 3, CarProjector.severityFor(97.0, steps))
        assertEquals("absent data is its own severity", 1, CarProjector.severityFor(null, steps))
        assertEquals("no thresholds means nominal", 0, CarProjector.severityFor(999.0, null))
    }

    @Test
    fun `a breached custom-named row is not nominal`() {
        // End-to-end guard for the defect: the fleet fixture's gpu threshold is
        // named "Busy", so a value above 85 must not come back severity 0.
        val series = mapOf(
            "gpu-utilization" to listOf(
                CarProjector.Series(mapOf("instance" to "gx10-5cc5"), listOf(90.0)),
            ),
        )
        val view = CarProjector.project(fleet(), series)
        val gpu = view.tabs.flatMap { it.rows }.first { it.label.contains("GPU") }
        assertEquals("Busy", gpu.state)
        assertEquals("a breached row must not read as nominal", 2, gpu.severity)
    }
}
