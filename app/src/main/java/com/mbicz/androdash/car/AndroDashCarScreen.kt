package com.mbicz.androdash.car

import android.content.Context
import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.constraints.ConstraintManager
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.CarIcon
import androidx.car.app.model.CarText
import androidx.core.graphics.drawable.IconCompat
import androidx.car.app.model.Header
import androidx.car.app.model.ItemList
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.SectionedItemList
import androidx.car.app.model.Tab
import androidx.car.app.model.TabContents
import androidx.car.app.model.TabTemplate
import androidx.car.app.model.Template
import com.mbicz.androdash.AppConfig
import com.mbicz.androdash.ConfigParser
import com.mbicz.androdash.ConfigStore
import com.mbicz.androdash.DashboardStore
import java.net.HttpURLConnection
import java.net.URI
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

/**
 * The car screen (C-010). It projects the same dashboard the phone renders into
 * glanceable rows, refreshes no faster than [REFRESH_FLOOR_SECONDS], and shows
 * an explicit message instead of fabricated data whenever a prerequisite is
 * missing or a fetch fails.
 */
class AndroDashCarScreen(carContext: CarContext) : Screen(carContext) {
    private val executor = Executors.newSingleThreadExecutor()
    private val refreshing = AtomicBoolean(false)

    @Volatile
    private var view: CarProjector.CarView? = null

    @Volatile
    private var error: String? = null

    @Volatile
    private var lastSuccessMillis: Long = 0L

    private var activeTabId: String? = null

    /** True until the first template request has kicked off a load. */
    private var started = false

    /** Rows the host will actually render, from [ConstraintManager] (C-010 geometry). */
    private fun contentLimit(): Int = try {
        carContext.getCarService(ConstraintManager::class.java)
            .getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_LIST)
    } catch (_: Exception) {
        CarProjector.MAX_ROWS_PER_TAB
    }

    override fun onGetTemplate(): Template {
        // Screen has no onCreate hook; the host's first onGetTemplate is the
        // earliest safe point to start the async load.
        if (!started) {
            started = true
            refresh()
        }

        val currentError = error
        if (currentError != null) {
            return MessageTemplate.Builder(currentError)
                .setTitle("AndroDash")
                .setHeaderAction(Action.APP_ICON)
                .build()
        }

        val current = view
            ?: return MessageTemplate.Builder("Loading the dashboard…")
                .setTitle("AndroDash")
                .setHeaderAction(Action.APP_ICON)
                .build()

        return tabsTemplate(current)
    }

    private fun tabsTemplate(view: CarProjector.CarView): Template {
        val builder = TabTemplate.Builder(tabCallback())
            .setHeaderAction(Action.APP_ICON)

        for (tab in view.tabs) {
            builder.addTab(
                Tab.Builder()
                    .setTitle(tab.title)
                    .setContentId(tab.title)
                    // CAL requires an icon on every tab.
                    .setIcon(
                        CarIcon.Builder(
                            IconCompat.createWithResource(
                                carContext,
                                com.mbicz.androdash.R.drawable.ic_launcher,
                            ),
                        ).build(),
                    )
                    .build(),
            )
        }

        val activeTab = view.tabs.firstOrNull { it.title == activeTabId } ?: view.tabs.first()
        builder.setActiveTabContentId(activeTab.title)
        builder.setTabContents(TabContents.Builder(listTemplate(activeTab, view)).build())
        return builder.build()
    }

    /**
     * Rows as a [ListTemplate]. Each row carries its state word, so a threshold
     * breach is visible without tapping. An empty tab states the omission counts
     * rather than looking broken.
     */
    private fun listTemplate(tab: CarProjector.Tab, view: CarProjector.CarView): Template {
        val limit = contentLimit().coerceAtLeast(1)
        val builder = ListTemplate.Builder()
            .setHeader(
                Header.Builder()
                    .setTitle(tab.title)
                    .setStartHeaderAction(Action.APP_ICON)
                    .build(),
            )

        if (tab.rows.isEmpty()) {
            builder.setSingleList(ItemList.Builder().addItem(summaryRow(view)).build())
            return builder.build()
        }

        // One ItemList only: a ListTemplate with both a single list and sectioned
        // lists renders the sections and drops the single list.
        val shown = tab.rows.take(limit)
        val items = ItemList.Builder()
        for (row in shown) {
            items.addItem(
                Row.Builder()
                    .setTitle(CarText.create(row.label))
                    .addText("${row.value} · ${row.state}${if (row.stale) " · stale" else ""}")
                    .build(),
            )
        }
        builder.setSingleList(items.build())

        val beyondLimit = tab.rows.size - shown.size
        if (beyondLimit > 0 || view.omittedCharts > 0 || view.omittedText > 0 ||
            view.omittedRows > 0 || view.failedPanels > 0
        ) {
            builder.setActionStrip(
                ActionStrip.Builder()
                    .addAction(
                        Action.Builder()
                            .setTitle(summaryText(view, beyondLimit))
                            .build(),
                    )
                    .build(),
            )
        }
        return builder.build()
    }

    private fun summaryText(view: CarProjector.CarView, beyondLimit: Int): String {
        val parts = ArrayList<String>()
        if (beyondLimit > 0) parts.add("$beyondLimit beyond host limit")
        if (view.omittedCharts > 0) parts.add("${view.omittedCharts} chart(s) hidden")
        if (view.omittedText > 0) parts.add("${view.omittedText} text hidden")
        if (view.omittedRows > 0) parts.add("${view.omittedRows} rows hidden")
        if (view.failedPanels > 0) parts.add("${view.failedPanels} no data")
        return if (parts.isEmpty()) "All shown" else parts.joinToString(" · ")
    }

    private fun summaryRow(view: CarProjector.CarView, beyondLimit: Int = 0): Row {
        val parts = ArrayList<String>()
        if (beyondLimit > 0) parts.add("$beyondLimit row(s) beyond the host limit")
        if (view.omittedCharts > 0) parts.add("${view.omittedCharts} chart(s) not shown")
        if (view.omittedText > 0) parts.add("${view.omittedText} text panel(s) not shown")
        if (view.omittedRows > 0) parts.add("${view.omittedRows} row(s) beyond the tab limit")
        if (view.failedPanels > 0) parts.add("${view.failedPanels} panel(s) with no data")
        val text = if (parts.isEmpty()) "All panels fit" else parts.joinToString(" · ")
        return Row.Builder()
            .setTitle(CarText.create("Summary"))
            .addText(text)
            .build()
    }

    private fun tabCallback() = object : TabTemplate.TabCallback {
        override fun onTabSelected(tabContentId: String) {
            activeTabId = tabContentId
            invalidate()
        }
    }

    /** Fetch off the main thread, then invalidate. Never blocks the host. */
    private fun refresh() {
        if (!refreshing.compareAndSet(false, true)) return
        executor.execute {
            try {
                val result = load()
                view = result.first
                error = result.second
                if (result.first != null) lastSuccessMillis = System.currentTimeMillis()
            } finally {
                refreshing.set(false)
                // Screen.invalidate() must run on the main thread; this executor is not it.
                android.os.Handler(android.os.Looper.getMainLooper()).post { invalidate() }
            }
        }
    }

    /** Returns the projected view, or an error message when a prerequisite is missing. */
    private fun load(): Pair<CarProjector.CarView?, String?> {
        val context = carContext.applicationContext
        val store = ConfigStore(context)
        val config = try {
            store.load()
        } catch (failure: Exception) {
            android.util.Log.w("AndroDashCar", "config load failed", failure)
            null
        }
        if (config == null) {
            android.util.Log.w("AndroDashCar", "no stored config for ${context.packageName}")
            return null to "Open AndroDash on the phone and configure a dashboard."
        }

        val baseUrl = CarPrometheus.normalizeBaseUrl(config.prometheusUrl)
            ?: return null to "Set prometheus_url on the phone: the car view needs a reachable Prometheus."

        val dashboard = try {
            readDashboard(context, config)
        } catch (failure: Exception) {
            return null to "Dashboard unavailable: ${failure.message ?: "read failed"}"
        }

        val panels = dashboard.optJSONObject("spec")?.optJSONObject("panels") ?: JSONObject()
        val durationSeconds = durationSeconds(dashboard)
        val seriesByPanel = HashMap<String, List<CarProjector.Series>>()

        for (id in panels.keys()) {
            val panel = panels.optJSONObject(id) ?: continue
            val kind = panel.optJSONObject("spec")
                ?.optJSONObject("plugin")
                ?.optString("kind")
                ?: continue
            if (kind != "StatChart" && kind != "GaugeChart" && kind != "Table") continue

            val query = panel.optJSONObject("spec")
                ?.optJSONArray("queries")
                ?.optJSONObject(0)
                ?.optJSONObject("spec")
                ?.optJSONObject("plugin")
                ?.optJSONObject("spec")
                ?.optString("query")
                ?.takeIf { it.isNotBlank() }
                ?: continue
            seriesByPanel[id] = CarPrometheus.queryRange(baseUrl, query, durationSeconds)
        }

        val stale = lastSuccessMillis > 0 &&
            System.currentTimeMillis() - lastSuccessMillis > 2L * REFRESH_FLOOR_SECONDS * 1000L

        android.util.Log.i(
            "AndroDashCar",
            "projected ${seriesByPanel.size} panels, ${seriesByPanel.values.sumOf { it.size }} series",
        )
        val projected = CarProjector.project(dashboard, seriesByPanel, stale)
        android.util.Log.i(
            "AndroDashCar",
            "tabs=${projected.tabs.map { "${it.title}:${it.rows.size}" }} " +
                "omittedCharts=${projected.omittedCharts} omittedText=${projected.omittedText} " +
                "omittedRows=${projected.omittedRows} failed=${projected.failedPanels}",
        )
        projected.tabs.forEach { tab ->
            tab.rows.take(4).forEach { android.util.Log.i("AndroDashCar", "  ${tab.title} | ${it.label} = ${it.value} (${it.state})") }
        }
        return projected to null
    }

    /** The stored copy for the current URL, else the bundled asset, else a fetch. */
    private fun readDashboard(context: Context, config: AppConfig): JSONObject {
        val url = config.dashboardUrl
        val prefix = "http://${ConfigParser.HOST}/dashboards/"
        if (url.startsWith(prefix)) {
            val name = url.removePrefix(prefix)
            val text = context.assets.open("dashboards/$name").bufferedReader().use { it.readText() }
            return JSONObject(text)
        }

        val slot = config.dashboardUrls.indexOf(url).takeIf { it >= 0 } ?: 0
        DashboardStore(context.filesDir).readDashboard(slot)?.let { bytes ->
            return JSONObject(String(bytes, Charsets.UTF_8))
        }

        val text = fetch(url) ?: throw IllegalStateException("could not fetch the dashboard")
        return JSONObject(text)
    }

    private fun fetch(url: String): String? {
        val connection = try {
            (URI(url).toURL().openConnection() as HttpURLConnection).apply {
                connectTimeout = 8_000
                readTimeout = 8_000
                instanceFollowRedirects = false
                requestMethod = "GET"
                setRequestProperty("Accept", "application/json")
            }
        } catch (_: Exception) {
            return null
        }
        return try {
            if (connection.responseCode !in 200..299) return null
            connection.inputStream.bufferedReader().use { it.readText() }
        } catch (_: Exception) {
            null
        } finally {
            connection.disconnect()
        }
    }

    /** Dashboard duration in seconds, defaulting to 1 h (C-002). */
    private fun durationSeconds(dashboard: JSONObject): Long {
        val raw = dashboard.optJSONObject("spec")?.optString("duration").orEmpty()
        val match = Regex("^([0-9]+)([smhdw])$").find(raw) ?: return 3600L
        val value = match.groupValues[1].toLongOrNull() ?: return 3600L
        return when (match.groupValues[2]) {
            "s" -> value
            "m" -> value * 60
            "h" -> value * 3600
            "d" -> value * 86_400
            "w" -> value * 604_800
            else -> 3600L
        }
    }

    companion object {
        /** C-010 refresh floor: never poll the car faster than this. */
        const val REFRESH_FLOOR_SECONDS = 10
    }
}
