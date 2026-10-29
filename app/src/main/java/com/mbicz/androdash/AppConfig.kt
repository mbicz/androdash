package com.mbicz.androdash

import org.json.JSONArray
import org.json.JSONObject

/**
 * Canonical launch configuration, C-001. Keep field names in sync with
 * contracts/app-config.schema.json and the web renderer parser.
 */
data class AppConfig(
    val dashboardUrl: String,
    val prometheusUrl: String? = null,
    val refreshSeconds: Int? = null,
    val timeRange: String? = null,
    val stepSeconds: Int? = null,
    val kiosk: Boolean = true,
    val debug: Boolean = false,
    val layoutMode: String = "auto",
    val displayMode: String = "standard",
    val lockStyle: String = "monochrome",
    val dashboardSource: String = "stored",
    val dashboardName: String? = null,
    val capabilities: List<String>? = null,
    val showUnsupported: Boolean = false,
    /** C-001 collector fields: native-only, never renderer query parameters (decision 0019). */
    val collector: Boolean = false,
    /** Canonical `collector_targets` (trimmed entries joined by `,`), or null when unset. */
    val collectorTargets: String? = null,
    val collectorScrapeSeconds: Int = DEFAULT_COLLECTOR_SCRAPE_SECONDS,
    val collectorRetention: String = DEFAULT_COLLECTOR_RETENTION,
    /**
     * C-001 `dashboard_urls`: 1–8 distinct dashboard URLs, always containing
     * [dashboardUrl] (the one currently shown). Each index is also the stored
     * copy's slot (decision 0018).
     */
    val dashboardUrls: List<String> = listOf(dashboardUrl),
    /** C-001 `rotate_seconds`: 0 = off, else 10–3600. */
    val rotateSeconds: Int = 0,
) {
    fun toJson(): String {
        val json = JSONObject()
        json.put("schemaVersion", 1)
        json.put("dashboardUrl", dashboardUrl)
        json.put("prometheusUrl", prometheusUrl ?: JSONObject.NULL)
        json.put("refreshSeconds", refreshSeconds ?: JSONObject.NULL)
        json.put("timeRange", timeRange ?: JSONObject.NULL)
        json.put("stepSeconds", stepSeconds ?: JSONObject.NULL)
        json.put("kiosk", kiosk)
        json.put("debug", debug)
        json.put("layoutMode", layoutMode)
        json.put("displayMode", displayMode)
        json.put("lockStyle", lockStyle)
        json.put("dashboardSource", dashboardSource)
        json.put("dashboardName", dashboardName ?: JSONObject.NULL)
        json.put(
            "capabilities",
            capabilities?.let { values ->
                JSONArray().apply { values.forEach { put(it) } }
            } ?: JSONObject.NULL,
        )
        json.put("showUnsupported", showUnsupported)
        json.put("collector", collector)
        json.put("collectorTargets", collectorTargets ?: JSONObject.NULL)
        json.put("collectorScrapeSeconds", collectorScrapeSeconds)
        json.put("collectorRetention", collectorRetention)
        json.put("dashboardUrls", JSONArray().apply { dashboardUrls.forEach { put(it) } })
        json.put("rotateSeconds", rotateSeconds)
        return json.toString()
    }

    companion object {
        const val DEFAULT_COLLECTOR_SCRAPE_SECONDS = 15
        const val DEFAULT_COLLECTOR_RETENTION = "24h"

        fun fromJson(raw: String?): AppConfig? {
            if (raw.isNullOrBlank()) return null
            return try {
                val json = JSONObject(raw)
                if (json.optInt("schemaVersion", 0) != 1) return null
                val capabilities = if (json.isNull("capabilities")) {
                    null
                } else {
                    val array = json.getJSONArray("capabilities")
                    if (array.length() == 0) return null
                    buildList<String> {
                        for (index in 0 until array.length()) add(array.getString(index))
                    }
                }
                val dashboardUrl = json.getString("dashboardUrl")
                val dashboardUrls = if (json.has("dashboardUrls")) {
                    val array = json.getJSONArray("dashboardUrls")
                    buildList<String> {
                        for (index in 0 until array.length()) add(array.getString(index))
                    }
                } else {
                    listOf(dashboardUrl)
                }
                AppConfig(
                    dashboardUrl = dashboardUrl,
                    prometheusUrl = json.optNullableString("prometheusUrl"),
                    refreshSeconds = json.optNullableInt("refreshSeconds"),
                    timeRange = json.optNullableString("timeRange"),
                    stepSeconds = json.optNullableInt("stepSeconds"),
                    kiosk = json.optBoolean("kiosk", true),
                    debug = json.optBoolean("debug", false),
                    layoutMode = json.optString("layoutMode", "auto"),
                    displayMode = json.optString("displayMode", "standard"),
                    lockStyle = json.optString("lockStyle", "monochrome"),
                    dashboardSource = json.optString("dashboardSource", "stored"),
                    dashboardName = json.optNullableString("dashboardName"),
                    capabilities = capabilities,
                    showUnsupported = json.optBoolean("showUnsupported", false),
                    collector = json.optBoolean("collector", false),
                    collectorTargets = json.optNullableString("collectorTargets"),
                    collectorScrapeSeconds = json.optInt(
                        "collectorScrapeSeconds",
                        DEFAULT_COLLECTOR_SCRAPE_SECONDS,
                    ),
                    collectorRetention = json.optString(
                        "collectorRetention",
                        DEFAULT_COLLECTOR_RETENTION,
                    ),
                    dashboardUrls = dashboardUrls,
                    rotateSeconds = json.optInt("rotateSeconds", 0),
                )
            } catch (_: Exception) {
                null
            }
        }

        private fun JSONObject.optNullableString(key: String): String? =
            if (isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }

        private fun JSONObject.optNullableInt(key: String): Int? =
            if (isNull(key)) null else optInt(key)
    }
}
