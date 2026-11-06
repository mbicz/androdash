package com.mbicz.androdash.car

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Pure projection of a normalized Perses dashboard (C-002) to a car view model
 * (C-010). No Android or CAL types: the caller feeds it the dashboard JSON and
 * the fetched series, and gets plain data back. Everything the car cannot show
 * is counted and reported, never silently dropped (constitution Article 3).
 */
object CarProjector {
    const val MAX_ROWS_PER_TAB = 10
    const val MAX_TABLE_ROWS = 8
    const val MAX_SERIES = 12
    const val MIN_TABS = 2
    const val MAX_TABS = 4

    /** A single glanceable line on a car screen. */
    data class Row(
        /** Series label, or the panel title when the panel has one series. */
        val label: String,
        /** Formatted value, or "—" when the series has no samples. */
        val value: String,
        /** Threshold state word: "Nominal", "Warning", "Critical", or "No data". */
        val state: String,
        /** True when the last successful fetch is older than the refresh budget. */
        val stale: Boolean = false,
        /**
         * A block sparkline (C-010): [SPARK_WIDTH] characters, or null when the
         * panel has no range data. Charts cannot be drawn in a car template, so
         * this is the only shape available.
         */
        val spark: String? = null,
    )

    /** One car tab: a title and the rows it holds. */
    data class Tab(val title: String, val rows: List<Row>)

    /**
     * The whole car view. [omittedCharts] and [omittedText] are counts, so the
     * Summary tab can state that this is a summary and not the full dashboard.
     */
    data class CarView(
        val tabs: List<Tab>,
        val omittedCharts: Int,
        val omittedText: Int,
        val omittedRows: Int,
        val failedPanels: Int,
    )

    /** A projected series: what the projector needs from one Prometheus result. */
    data class Series(
        val labels: Map<String, String>,
        /** Sample values in time order; empty when the query returned nothing. */
        val values: List<Double>,
    )

    /**
     * Project [dashboard] with [seriesByPanel] (panel id → its series) into a car
     * view. Panels absent from [seriesByPanel] are treated as having no data,
     * which renders as "—" rather than as a fabricated zero.
     */
    fun project(
        dashboard: JSONObject,
        seriesByPanel: Map<String, List<Series>>,
        stale: Boolean = false,
    ): CarView {
        val panels = panelsInReadingOrder(dashboard)
        val statRows = ArrayList<Row>()
        val gaugeRows = ArrayList<Row>()
        val chartRows = ArrayList<Row>()
        val tableRows = ArrayList<Row>()
        var omittedCharts = 0
        var omittedText = 0
        var failedPanels = 0

        for (panel in panels) {
            val kind = panel.panelKind
            when {
                kind == "TimeSeriesChart" -> {
                    // A chart cannot be drawn in a template, but its shape can be
                    // shown as a text sparkline, which is honest and glanceable.
                    val rows = sparkRows(panel, seriesByPanel[panel.id].orEmpty(), stale)
                    if (rows.isEmpty() && seriesByPanel.containsKey(panel.id)) failedPanels++
                    if (rows.isEmpty()) omittedCharts++ else chartRows.addAll(rows)
                }
                kind == "Markdown" -> omittedText++
                kind == "StatChart" || kind == "GaugeChart" -> {
                    val rows = valueRows(panel, seriesByPanel[panel.id].orEmpty(), stale)
                    if (rows.isEmpty() && seriesByPanel.containsKey(panel.id)) failedPanels++
                    if (kind == "StatChart") statRows.addAll(rows) else gaugeRows.addAll(rows)
                }
                kind == "Table" -> {
                    val rows = tableRowsFor(panel, seriesByPanel[panel.id].orEmpty(), stale)
                    if (rows.isEmpty() && seriesByPanel.containsKey(panel.id)) failedPanels++
                    tableRows.addAll(rows)
                }
                // Unknown kinds are omitted by C-004 before reaching here; count
                // them as text omissions so nothing disappears without a trace.
                else -> omittedText++
            }
        }

        val ordered = statRows + gaugeRows + chartRows
        val (tabs, spilled) = packTabs(ordered, tableRows)

        return CarView(
            tabs = tabs,
            omittedCharts = omittedCharts,
            omittedText = omittedText,
            omittedRows = spilled,
            failedPanels = failedPanels,
        )
    }

    /**
     * Pack rows into 2–4 tabs of at most [maxRowsPerTab] rows each. Values come
     * first, then table rows. Overflow is returned as a count, never dropped.
     */
    private fun packTabs(
        valueRows: List<Row>,
        tableRows: List<Row>,
        maxRowsPerTab: Int = MAX_ROWS_PER_TAB,
    ): Pair<List<Tab>, Int> {
        val titles = listOf("Fleet", "Inference", "Models")
        val buckets = ArrayList<MutableList<Row>>()
        var remaining = valueRows + tableRows
        var spilled = 0

        for (title in titles) {
            val bucket = ArrayList<Row>()
            while (bucket.size < maxRowsPerTab && remaining.isNotEmpty()) {
                bucket.add(remaining.first())
                remaining = remaining.drop(1)
            }
            buckets.add(bucket)
            if (remaining.isEmpty()) break
        }
        if (remaining.isNotEmpty()) {
            // Every tab is full: report the remainder rather than hiding it.
            spilled = remaining.size
        }

        val tabs = ArrayList<Tab>()
        for ((index, bucket) in buckets.withIndex()) {
            if (bucket.isEmpty()) continue
            tabs.add(Tab(titles[index], bucket))
        }
        // CAL requires at least two tabs; an empty second tab is honest ("nothing
        // else to show") and keeps the template valid.
        while (tabs.size < MIN_TABS) {
            tabs.add(Tab("Summary", emptyList()))
        }
        return tabs.take(MAX_TABS) to spilled
    }

    /** Stat/gauge rows: one per series, formatted exactly as C-005 does. */
    private fun valueRows(panel: PanelRef, series: List<Series>, stale: Boolean): List<Row> {
        if (series.isEmpty()) {
            // A queried panel that returned nothing must still be visible: dropping
            // it would be the silent omission Article 3 forbids.
            return listOf(Row(panel.title, "—", "No data", stale))
        }
        return series.take(MAX_SERIES).mapNotNull { item ->
            val value = calculation(item.values, panel.calculation)
            val formatted = formatValue(value, panel.format)
            val state = thresholdState(value, panel.thresholds)
            val label = rowLabel(panel.title, item.labels, series.size)
            Row(label, formatted, state, stale)
        }
    }

    /** Table rows: label plus the formatted last value, capped at [MAX_TABLE_ROWS]. */
    private fun tableRowsFor(panel: PanelRef, series: List<Series>, stale: Boolean): List<Row> {
        if (series.isEmpty()) return listOf(Row(panel.title, "—", "No data", stale))
        return series.take(MAX_TABLE_ROWS).mapNotNull { item ->
            val value = calculation(item.values, "last-number")
            val formatted = formatValue(value, panel.format)
            val label = rowLabel(panel.title, item.labels, series.size)
            Row(label, formatted, thresholdState(value, null), stale)
        }
    }

    /**
     * Time-series rows: one per series, with a text sparkline of the range and
     * the last value. A chart cannot be drawn in a CAL template (C-010), so this
     * is the shape the car gets. An empty range yields no rows, which the caller
     * counts as an omitted chart.
     */
    private fun sparkRows(panel: PanelRef, series: List<Series>, stale: Boolean): List<Row> =
        series.take(MAX_SERIES).mapNotNull { item ->
            val spark = sparkline(item.values) ?: return@mapNotNull null
            val value = calculation(item.values, panel.calculation)
            val formatted = formatValue(value, panel.format)
            val label = rowLabel(panel.title, item.labels, series.size)
            Row(label, formatted, thresholdState(value, panel.thresholds), stale, spark)
        }

    /**
     * Block characters, low to high. Measured on the car host font: every one of
     * these advances 23.00 px, so a row tiles into a continuous filled area.
     *
     * Braille (`U+2800..U+28FF`, 22.00 px) is also fixed-width and packs a 2x4
     * dot grid, but its dots are *sparse by design*: on screen they render as
     * isolated clusters separated by gaps, so a plot built from them reads as
     * broken rather than as an area. Two text lines also carry a line gap
     * between them, which is why a two-line raster looks vertically offset.
     * Blocks fill their whole cell, so one line is both continuous and aligned.
     */
    val SPARK = charArrayOf('\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588')

    /** Cells per sparkline. Fits a car row beside its value. */
    const val SPARK_WIDTH = 24

    /**
     * Status badge, not a graph pixel. Emoji advance widths are NOT fixed
     * (measured 30/33/40 px), so they can only sit at the end of a line where
     * alignment does not matter. Never use them inside a raster.
     */
    fun stateBadge(state: String): String = when (state) {
        "Critical" -> "\uD83D\uDD34" // red circle
        "Warning" -> "\uD83D\uDFE1" // orange circle
        "No data" -> "\u26AA" // white circle
        else -> "\uD83D\uDFE2" // green circle
    }

    /**
     * Render [values] as a fixed-width block sparkline of [width] cells.
     *
     * The lowest level is `▁` (lower one-eighth block) rather than a space, so
     * every cell has the same 23.00 px advance and the row never shifts. The
     * range is bucketed per cell and averaged, so a long range keeps its shape.
     * A flat series renders mid-height rather than collapsing to the baseline,
     * which would read as zero. Null when there is no data.
     */
    fun sparkline(values: List<Double>, width: Int = SPARK_WIDTH): String? {
        val finite = values.filter { it.isFinite() }
        if (finite.isEmpty() || width <= 0) return null

        val buckets = ArrayList<Double>(width)
        for (slot in 0 until width) {
            val start = slot * finite.size / width
            val end = maxOf(start + 1, (slot + 1) * finite.size / width)
            val slice = finite.subList(start.coerceAtMost(finite.size), end.coerceAtMost(finite.size))
            buckets.add(if (slice.isEmpty()) finite.last() else slice.average())
        }

        val low = buckets.min()
        val high = buckets.max()
        val span = high - low
        val builder = StringBuilder(width)
        for (bucket in buckets) {
            val level = if (span <= 0.0) {
                SPARK.size / 2
            } else {
                (((bucket - low) / span) * (SPARK.size - 1)).toInt().coerceIn(0, SPARK.size - 1)
            }
            builder.append(SPARK[level])
        }
        return builder.toString()
    }

    /** `instance · title` when there is more than one series, else the panel title. */
    private fun rowLabel(panelTitle: String, labels: Map<String, String>, seriesCount: Int): String {
        if (seriesCount <= 1) return panelTitle
        val instance = labels["instance"] ?: labels["model"] ?: labels["host"] ?: return panelTitle
        return "$instance · $panelTitle"
    }

    /** A panel plus the fields the projector reads from its spec. */
    private class PanelRef(
        val id: String,
        val title: String,
        val panelKind: String,
        val calculation: String,
        val format: JSONObject?,
        val thresholds: JSONArray?,
    )

    /** Panels in reading order: rows as laid out, then any panel not in a row. */
    private fun panelsInReadingOrder(dashboard: JSONObject): List<PanelRef> {
        val spec = dashboard.optJSONObject("spec") ?: return emptyList()
        val rawPanels = spec.optJSONObject("panels") ?: JSONObject()
        val refs = LinkedHashMap<String, PanelRef>()
        for (id in rawPanels.keys()) {
            val panel = rawPanels.optJSONObject(id) ?: continue
            refs[id] = panelRef(id, panel)
        }

        val ordered = ArrayList<PanelRef>()
        val seen = HashSet<String>()
        val layouts = spec.optJSONObject("layouts")
        val rows = layouts?.optJSONArray("rows") ?: JSONArray()
        for (i in 0 until rows.length()) {
            val row = rows.optJSONObject(i) ?: continue
            val items = row.optJSONArray("items") ?: continue
            for (j in 0 until items.length()) {
                val item = items.optJSONObject(j) ?: continue
                val ref = item.optString("panelId").takeIf { it.isNotEmpty() } ?: continue
                refs[ref]?.let { if (seen.add(ref)) ordered.add(it) }
            }
        }
        for ((id, ref) in refs) if (seen.add(id)) ordered.add(ref)
        return ordered
    }

    private fun panelRef(id: String, panel: JSONObject): PanelRef {
        val spec = panel.optJSONObject("spec")
        val display = spec?.optJSONObject("display")
        val plugin = spec?.optJSONObject("plugin")
        val pluginSpec = plugin?.optJSONObject("spec")
        return PanelRef(
            id = id,
            title = display?.optString("name")?.takeIf { it.isNotEmpty() } ?: id,
            panelKind = plugin?.optString("kind") ?: panel.optString("kind"),
            calculation = pluginSpec?.optString("calculation")?.takeIf { it.isNotEmpty() } ?: "last-number",
            format = pluginSpec?.optJSONObject("format"),
            thresholds = pluginSpec?.optJSONObject("thresholds")?.optJSONArray("steps"),
        )
    }

    // --- Formatting, mirroring web/app/src/panels/format.js (C-005) ---

    fun calculation(values: List<Double>, mode: String): Double? {
        if (mode == "count") return values.size.toDouble()
        if (values.isEmpty()) return null
        return when (mode) {
            "first-number" -> values.first()
            "mean" -> values.average()
            "sum" -> values.sum()
            "min" -> values.min()
            "max" -> values.max()
            else -> values.last()
        }
    }

    fun formatValue(value: Double?, format: JSONObject?): String {
        if (value == null || !value.isFinite()) return "—"
        val unit = format?.optString("unit")?.takeIf { it.isNotEmpty() } ?: "none"
        val decimals = decimalsFor(value, format)
        return when (unit) {
            "percent" -> "${fixed(value, decimals)}%"
            "bytes" -> formatBytes(value, 1024.0, listOf("B", "KiB", "MiB", "GiB", "TiB"))
            "decbytes" -> formatBytes(value, 1000.0, listOf("B", "KB", "MB", "GB", "TB"))
            "seconds" -> "${fixed(value, decimals)} s"
            "milliseconds" -> "${fixed(value, decimals)} ms"
            "watts" -> formatScaled(value, 1000.0, listOf("W", "kW", "MW"))
            "celsius" -> "${fixed(value, decimals)} °C"
            "hertz" -> formatScaled(value, 1000.0, listOf("Hz", "kHz", "MHz", "GHz", "THz"))
            "bits" -> formatScaled(value, 1000.0, listOf("b/s", "Kb/s", "Mb/s", "Gb/s", "Tb/s"))
            "tokens" -> "${formatShort(value)} tok/s"
            "short" -> formatShort(value)
            else -> fixed(value, decimals)
        }
    }

    fun thresholdState(value: Double?, steps: JSONArray?): String {
        if (value == null || !value.isFinite()) return "No data"
        val sorted = sortedThresholds(steps)
        if (sorted.isEmpty()) return "Nominal"
        if (sorted.size == 1) {
            return if (value >= sorted[0].first) sorted[0].second ?: "Critical" else "Nominal"
        }
        if (value >= sorted[1].first) return sorted[1].second ?: "Critical"
        if (value >= sorted[0].first) return sorted[0].second ?: "Warning"
        return "Nominal"
    }

    private fun sortedThresholds(steps: JSONArray?): List<Pair<Double, String?>> {
        if (steps == null) return emptyList()
        val out = ArrayList<Pair<Double, String?>>()
        for (i in 0 until steps.length()) {
            val step = steps.optJSONObject(i) ?: continue
            if (!step.has("value")) continue
            val value = step.optDouble("value")
            if (!value.isFinite()) continue
            out.add(value to step.optString("name").takeIf { it.isNotEmpty() })
        }
        return out.sortedBy { it.first }
    }

    private fun decimalsFor(value: Double, format: JSONObject?): Int {
        val configured = format?.optInt("decimalPlaces", -1) ?: -1
        if (configured >= 0) return configured
        val magnitude = abs(value)
        return when {
            magnitude >= 100 -> 0
            magnitude >= 1 -> 1
            else -> 2
        }
    }

    private fun fixed(value: Double, decimals: Int): String =
        String.format(java.util.Locale.US, "%.${decimals}f", value)

    private fun stripZero(text: String): String =
        if (text.contains('.')) text.trimEnd('0').trimEnd('.') else text

    private fun formatScaled(value: Double, base: Double, units: List<String>): String {
        var number = value
        var index = 0
        while (abs(number) >= base && index < units.size - 1) {
            number /= base
            index++
        }
        val magnitude = abs(number)
        val decimals = if (index == 0) {
            when {
                magnitude >= 100 -> 0
                magnitude >= 10 -> 1
                else -> 2
            }
        } else {
            if (magnitude >= 10) 1 else 2
        }
        return "${stripZero(fixed(number, decimals))} ${units[index]}"
    }

    private fun formatBytes(value: Double, base: Double, units: List<String>): String {
        var number = value
        var index = 0
        while (abs(number) >= base && index < units.size - 1) {
            number /= base
            index++
        }
        val decimals = if (index == 0) 0 else if (abs(number) >= 10) 1 else 2
        return "${stripZero(fixed(number, decimals))} ${units[index]}"
    }

    fun formatShort(value: Double): String {
        val magnitude = abs(value)
        val sign = if (value < 0) "-" else ""
        return when {
            magnitude >= 1e12 -> "$sign${stripZero(fixed(magnitude / 1e12, 1))}T"
            magnitude >= 1e9 -> "$sign${stripZero(fixed(magnitude / 1e9, 1))}B"
            magnitude >= 1e6 -> "$sign${stripZero(fixed(magnitude / 1e6, 1))}M"
            magnitude >= 1e3 -> "$sign${stripZero(fixed(magnitude / 1e3, 1))}K"
            else -> "$sign${stripZero(fixed(magnitude, if (magnitude >= 100) 0 else 1))}"
        }
    }
}
