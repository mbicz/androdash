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
    val dashboardName: String? = null,
    val capabilities: List<String>? = null,
    val showUnsupported: Boolean = false,
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
        json.put("dashboardName", dashboardName ?: JSONObject.NULL)
        json.put(
            "capabilities",
            capabilities?.let { values ->
                JSONArray().apply { values.forEach { put(it) } }
            } ?: JSONObject.NULL,
        )
        json.put("showUnsupported", showUnsupported)
        return json.toString()
    }

    companion object {
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
                AppConfig(
                    dashboardUrl = json.getString("dashboardUrl"),
                    prometheusUrl = json.optNullableString("prometheusUrl"),
                    refreshSeconds = json.optNullableInt("refreshSeconds"),
                    timeRange = json.optNullableString("timeRange"),
                    stepSeconds = json.optNullableInt("stepSeconds"),
                    kiosk = json.optBoolean("kiosk", true),
                    debug = json.optBoolean("debug", false),
                    layoutMode = json.optString("layoutMode", "auto"),
                    displayMode = json.optString("displayMode", "standard"),
                    dashboardName = json.optNullableString("dashboardName"),
                    capabilities = capabilities,
                    showUnsupported = json.optBoolean("showUnsupported", false),
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
