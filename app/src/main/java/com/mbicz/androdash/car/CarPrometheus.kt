package com.mbicz.androdash.car

import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import org.json.JSONObject

/**
 * Fetch the series a car projection needs (C-003, C-010). Every panel is queried
 * with `query_range` over the dashboard duration so `calculation` sees the same
 * samples the phone does; a panel whose query fails yields an empty series list
 * and is counted by [CarProjector], never replaced with a fabricated value.
 *
 * All calls are blocking and must run off the main thread.
 */
object CarPrometheus {
    private const val TIMEOUT_MILLIS = 8_000
    private const val MAX_BYTES = 4 * 1024 * 1024

    /** Prometheus base URL with trailing slashes removed, or null when unusable. */
    fun normalizeBaseUrl(baseUrl: String?): String? {
        val trimmed = baseUrl?.trim().orEmpty()
        if (trimmed.isEmpty()) return null
        val uri = try {
            URI(trimmed)
        } catch (_: Exception) {
            return null
        }
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        if (uri.host.isNullOrEmpty()) return null
        return trimmed.trimEnd('/')
    }

    /** One `query_range` over [durationSeconds], returning parsed series. */
    fun queryRange(
        baseUrl: String,
        query: String,
        durationSeconds: Long,
        nowMillis: Long = System.currentTimeMillis(),
    ): List<CarProjector.Series> {
        val step = maxOf(15L, (durationSeconds / 240L).coerceAtLeast(15L))
        val start = (nowMillis / 1000.0) - durationSeconds
        val end = nowMillis / 1000.0
        val params = listOf(
            "query" to query,
            "start" to String.format(java.util.Locale.US, "%.3f", start),
            "end" to String.format(java.util.Locale.US, "%.3f", end),
            "step" to step.toString(),
            "timeout" to "10s",
        ).joinToString("&") { (key, value) ->
            "$key=${URLEncoder.encode(value, "UTF-8")}"
        }
        val body = get("$baseUrl/api/v1/query_range?$params") ?: return emptyList()
        return parseMatrix(body)
    }

    private fun get(url: String): String? {
        val connection = try {
            (URI(url).toURL().openConnection() as HttpURLConnection).apply {
                connectTimeout = TIMEOUT_MILLIS
                readTimeout = TIMEOUT_MILLIS
                instanceFollowRedirects = false
                requestMethod = "GET"
                setRequestProperty("Accept", "application/json")
            }
        } catch (_: Exception) {
            return null
        }
        return try {
            if (connection.responseCode !in 200..299) return null
            val out = ByteArrayOutputStream()
            connection.inputStream.use { input ->
                val buffer = ByteArray(16 * 1024)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    out.write(buffer, 0, count)
                    if (out.size() > MAX_BYTES) return null
                }
            }
            out.toString("UTF-8")
        } catch (_: Exception) {
            null
        } finally {
            connection.disconnect()
        }
    }

    /** Parse a Prometheus `matrix` envelope into series; malformed input yields an empty list. */
    fun parseMatrix(body: String): List<CarProjector.Series> {
        val envelope = try {
            JSONObject(body)
        } catch (_: Exception) {
            return emptyList()
        }
        if (envelope.optString("status") != "success") return emptyList()
        val data = envelope.optJSONObject("data") ?: return emptyList()
        val result = data.optJSONArray("result") ?: return emptyList()
        val series = ArrayList<CarProjector.Series>()
        for (i in 0 until result.length()) {
            val item = result.optJSONObject(i) ?: continue
            val values = item.optJSONArray("values") ?: continue
            val points = ArrayList<Double>(values.length())
            for (j in 0 until values.length()) {
                val sample = values.optJSONArray(j) ?: continue
                if (sample.length() < 2) continue
                val raw = sample.optString(1)
                val parsed = raw.toDoubleOrNull() ?: continue
                if (parsed.isFinite()) points.add(parsed)
            }
            val metric = item.optJSONObject("metric") ?: JSONObject()
            val labels = HashMap<String, String>()
            for (key in metric.keys()) labels[key] = metric.optString(key)
            series.add(CarProjector.Series(labels, points))
        }
        return series
    }
}
