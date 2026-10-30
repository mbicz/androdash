package com.mbicz.androdash

import org.json.JSONArray
import org.json.JSONObject

/** Supervisor state shared between [CollectorService] and the bridge (one process). */
data class CollectorRuntime(
    val running: Boolean = false,
    val restarts: Int = 0,
    /** Wall-clock start of the current process, unix ms; null when not running. */
    val startedAt: Long? = null,
    val lastExit: String? = null,
)

/**
 * `AndroDash.collectorStatus()` payload (C-007). [toJson] stays within
 * [MAX_BYTES]: trailing targets are dropped when the full list would not fit.
 */
data class CollectorStatus(
    val enabled: Boolean,
    val running: Boolean,
    val url: String?,
    val targets: List<CollectorTarget>,
    val restarts: Int,
    val startedAt: Long?,
    val lastExit: String?,
) {
    fun toJson(): String {
        var count = targets.size
        while (true) {
            val text = render(count)
            if (text.toByteArray(Charsets.UTF_8).size <= MAX_BYTES || count == 0) return text
            count--
        }
    }

    private fun render(targetCount: Int): String {
        val json = JSONObject()
        json.put("enabled", enabled)
        json.put("running", running)
        json.put("url", url ?: JSONObject.NULL)
        json.put(
            "targets",
            JSONArray().apply {
                targets.take(targetCount).forEach { target ->
                    put(
                        JSONObject()
                            .put("job", target.job)
                            .put("instance", target.instance)
                            .put("address", target.address),
                    )
                }
            },
        )
        json.put("restarts", restarts)
        json.put("startedAt", startedAt ?: JSONObject.NULL)
        json.put("lastExit", lastExit ?: JSONObject.NULL)
        return json.toString()
    }

    companion object {
        const val MAX_BYTES = 4096
        const val MAX_LAST_EXIT = 200

        /**
         * Status for the current [config] and supervisor [runtime]. `targets`
         * lists the configured targets even while the collector is disabled;
         * `url` is set only while it is enabled.
         */
        fun of(config: AppConfig?, runtime: CollectorRuntime): CollectorStatus {
            val collector = config?.let { CollectorConfig.from(it) }
            return CollectorStatus(
                enabled = collector != null,
                running = runtime.running,
                url = if (collector != null) CollectorConfig.URL else null,
                targets = config?.let(CollectorConfig::configuredTargets).orEmpty(),
                restarts = runtime.restarts,
                startedAt = if (runtime.running) runtime.startedAt else null,
                lastExit = runtime.lastExit?.let(::sanitizeExit),
            )
        }

        /** Printable ASCII, at most [MAX_LAST_EXIT] characters. */
        fun sanitizeExit(value: String): String {
            val cleaned = value.map { if (it in ' '..'~') it else ' ' }.joinToString("")
            return if (cleaned.length > MAX_LAST_EXIT) cleaned.take(MAX_LAST_EXIT) else cleaned
        }

        /** Fallback when building the status fails; never thrown to JS. */
        const val UNAVAILABLE =
            "{\"enabled\":false,\"running\":false,\"url\":null,\"targets\":[]," +
                "\"restarts\":0,\"startedAt\":null,\"lastExit\":null}"
    }
}
