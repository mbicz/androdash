package com.mbicz.androdash

import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

class ConfigException(
    val code: String,
    message: String,
) : IllegalArgumentException(message)

data class ParsedLaunch(
    val config: AppConfig,
    val lockTask: Boolean,
    val showWhenLocked: Boolean,
    val warnings: List<String>,
)

/**
 * Pure C-001 parsing and local URL building. MainActivity supplies Intent
 * extras as strings and the last persisted config; unit tests exercise this
 * without an Android device.
 */
object ConfigParser {
    const val HOST = "androdash.local"
    const val LAUNCH_URL = "http://$HOST/index.html"

    private const val MAX_URL = 8192
    private const val MAX_QUERY = 2000
    private const val MAX_NAME = 256
    private const val MAX_CAPABILITIES = 16
    private const val MAX_REFRESH = 3600
    private const val MAX_STEP = 86400
    private val CAPABILITY = Regex("^[a-z0-9][a-z0-9_-]*$")
    private val LAYOUTS = setOf("auto", "grid", "stack")
    private val DISPLAY_MODES = setOf("standard", "amoled", "monochrome")
    private val INTEGER = Regex("^-?\\d+$")
    private val DURATION_PART = Regex("(\\d+)(ms|s|m|h|d|w)")

    fun parse(extras: Map<String, String?>, persisted: AppConfig? = null): ParsedLaunch {
        val warnings = ArrayList<String>()
        val base = persisted

        val dashboardUrl = when {
            extras.containsKey("dashboard_url") -> {
                val raw = extras["dashboard_url"]?.trim().orEmpty()
                if (raw.isEmpty()) {
                    throw ConfigException("E_CONFIG", "dashboard_url must not be empty")
                }
                validateUrl(raw, "dashboard_url")
            }
            base != null -> validateUrl(base.dashboardUrl, "dashboard_url")
            else -> throw ConfigException("E_CONFIG", "dashboard_url is required")
        }

        val prometheusUrl = when {
            !extras.containsKey("prometheus_url") -> base?.prometheusUrl
            extras["prometheus_url"].isNullOrBlank() -> base?.prometheusUrl
            else -> validateUrl(extras.getValue("prometheus_url")!!.trim(), "prometheus_url")
        }

        val refreshSeconds = when {
            !extras.containsKey("refresh_seconds") -> base?.refreshSeconds
            extras["refresh_seconds"].isNullOrBlank() -> base?.refreshSeconds
            else -> {
                val value = parseInteger(extras.getValue("refresh_seconds")!!, "refresh_seconds")
                if (value < 0 || value > MAX_REFRESH) {
                    throw ConfigException("E_CONFIG", "refresh_seconds must be between 0 and $MAX_REFRESH")
                }
                if (value in 1..4) {
                    warnings.add("W_REFRESH_CLAMPED: refresh_seconds raised to 5")
                    5
                } else {
                    value
                }
            }
        }

        val timeRange = when {
            !extras.containsKey("time_range") -> base?.timeRange
            extras["time_range"].isNullOrBlank() -> base?.timeRange
            else -> {
                val value = extras.getValue("time_range")!!.trim()
                validateDuration(value)
                value
            }
        }

        val stepSeconds = when {
            !extras.containsKey("step_seconds") -> base?.stepSeconds
            extras["step_seconds"].isNullOrBlank() -> base?.stepSeconds
            else -> {
                val value = parseInteger(extras.getValue("step_seconds")!!, "step_seconds")
                if (value !in 1..MAX_STEP) {
                    throw ConfigException("E_CONFIG", "step_seconds must be between 1 and $MAX_STEP")
                }
                value
            }
        }

        val kiosk = parseBoolean(extras, "kiosk", base?.kiosk ?: true)
        val debug = parseBoolean(extras, "debug", base?.debug ?: false)
        val showUnsupported = parseBoolean(
            extras,
            "show_unsupported",
            base?.showUnsupported ?: false,
        )

        val layoutMode = when {
            !extras.containsKey("layout_mode") -> base?.layoutMode ?: "auto"
            extras["layout_mode"].isNullOrBlank() -> base?.layoutMode ?: "auto"
            else -> {
                val value = extras.getValue("layout_mode")!!.trim().lowercase()
                if (value !in LAYOUTS) {
                    throw ConfigException("E_CONFIG", "layout_mode must be auto, grid, or stack")
                }
                value
            }
        }

        val displayMode = when {
            !extras.containsKey("display_mode") -> base?.displayMode ?: "standard"
            extras["display_mode"].isNullOrBlank() -> base?.displayMode ?: "standard"
            else -> {
                val value = extras.getValue("display_mode")!!.trim().lowercase()
                if (value !in DISPLAY_MODES) {
                    throw ConfigException(
                        "E_CONFIG",
                        "display_mode must be standard, amoled, or monochrome",
                    )
                }
                value
            }
        }

        val dashboardName = when {
            !extras.containsKey("dashboard_name") -> base?.dashboardName
            extras["dashboard_name"].isNullOrBlank() -> base?.dashboardName
            else -> {
                val value = extras.getValue("dashboard_name")!!.trim()
                if (value.length > MAX_NAME) {
                    throw ConfigException("E_CONFIG", "dashboard_name must be at most $MAX_NAME characters")
                }
                value
            }
        }

        val capabilities = when {
            !extras.containsKey("capabilities") -> base?.capabilities
            extras["capabilities"].isNullOrBlank() -> base?.capabilities
            else -> parseCapabilities(extras.getValue("capabilities")!!)
        }

        val config = AppConfig(
            dashboardUrl = dashboardUrl,
            prometheusUrl = prometheusUrl,
            refreshSeconds = refreshSeconds,
            timeRange = timeRange,
            stepSeconds = stepSeconds,
            kiosk = kiosk,
            debug = debug,
            layoutMode = layoutMode,
            displayMode = displayMode,
            dashboardName = dashboardName,
            capabilities = capabilities,
            showUnsupported = showUnsupported,
        )
        validateConfig(config)
        val query = buildQuery(config)
        if (query.length > MAX_QUERY) {
            throw ConfigException("E_CONFIG", "Launch query string exceeds $MAX_QUERY characters")
        }

        val requestedLockTask = parseBoolean(extras, "lock_task", false)
        val requestedShowWhenLocked = parseBoolean(extras, "show_when_locked", false)
        return ParsedLaunch(
            config = config,
            lockTask = kiosk && requestedLockTask,
            showWhenLocked = kiosk && requestedShowWhenLocked,
            warnings = warnings,
        )
    }

    fun decodePersisted(raw: String?): AppConfig? {
        val config = AppConfig.fromJson(raw) ?: return null
        return try {
            validateConfig(config)
            config
        } catch (_: ConfigException) {
            null
        }
    }

    fun buildQuery(config: AppConfig): String {
        val parts = ArrayList<String>()
        fun add(name: String, value: String?) {
            if (value == null) return
            parts.add("$name=${encode(value)}")
        }
        add("dashboard_url", config.dashboardUrl)
        add("prometheus_url", config.prometheusUrl)
        add("refresh_seconds", config.refreshSeconds?.toString())
        add("time_range", config.timeRange)
        add("step_seconds", config.stepSeconds?.toString())
        add("kiosk", config.kiosk.toString())
        add("debug", config.debug.toString())
        add("layout_mode", config.layoutMode)
        add("display_mode", config.displayMode)
        add("dashboard_name", config.dashboardName)
        add("capabilities", config.capabilities?.joinToString(","))
        add("show_unsupported", config.showUnsupported.toString())
        return parts.joinToString("&")
    }

    fun launchUrl(config: AppConfig): String = "$LAUNCH_URL?${buildQuery(config)}"

    fun validateConfig(config: AppConfig) {
        validateUrl(config.dashboardUrl, "dashboard_url")
        config.prometheusUrl?.let { validateUrl(it, "prometheus_url") }
        config.refreshSeconds?.let {
            if (it < 0 || it > MAX_REFRESH) {
                throw ConfigException("E_CONFIG", "refresh_seconds must be between 0 and $MAX_REFRESH")
            }
        }
        config.timeRange?.let { validateDuration(it) }
        config.stepSeconds?.let {
            if (it !in 1..MAX_STEP) {
                throw ConfigException("E_CONFIG", "step_seconds must be between 1 and $MAX_STEP")
            }
        }
        if (config.layoutMode !in LAYOUTS) {
            throw ConfigException("E_CONFIG", "layout_mode must be auto, grid, or stack")
        }
        if (config.displayMode !in DISPLAY_MODES) {
            throw ConfigException(
                "E_CONFIG",
                "display_mode must be standard, amoled, or monochrome",
            )
        }
        config.dashboardName?.let {
            if (it.isEmpty() || it.length > MAX_NAME) {
                throw ConfigException("E_CONFIG", "dashboard_name must be non-empty and at most $MAX_NAME characters")
            }
        }
        config.capabilities?.let { values ->
            if (values.isEmpty()) {
                throw ConfigException("E_CONFIG", "capabilities must not be empty when present")
            }
            if (values.size > MAX_CAPABILITIES) {
                throw ConfigException("E_CONFIG", "capabilities must contain at most $MAX_CAPABILITIES IDs")
            }
            if (values.any { !CAPABILITY.matches(it) }) {
                throw ConfigException("E_CONFIG", "capabilities contains an invalid ID")
            }
            if (values.distinct().size != values.size) {
                throw ConfigException("E_CONFIG", "capabilities contains duplicate IDs")
            }
        }
    }

    private fun validateUrl(value: String, name: String): String {
        if (value.length > MAX_URL) {
            throw ConfigException("E_CONFIG", "$name exceeds $MAX_URL characters")
        }
        val uri = try {
            URI(value)
        } catch (_: Exception) {
            throw ConfigException("E_CONFIG", "$name is not a valid URL")
        }
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") {
            throw ConfigException("E_CONFIG", "$name must use http or https")
        }
        if (uri.host.isNullOrBlank()) {
            throw ConfigException("E_CONFIG", "$name must include a host")
        }
        if (uri.userInfo != null) {
            throw ConfigException("E_CONFIG", "$name must not include credentials")
        }
        return value
    }

    private fun parseBoolean(extras: Map<String, String?>, name: String, fallback: Boolean): Boolean {
        if (!extras.containsKey(name)) return fallback
        val raw = extras[name]?.trim().orEmpty()
        if (raw.isEmpty()) return fallback
        return when (raw.lowercase()) {
            "true" -> true
            "false" -> false
            else -> throw ConfigException("E_CONFIG", "$name must be true or false")
        }
    }

    private fun parseInteger(value: String, name: String): Int {
        val raw = value.trim()
        if (!INTEGER.matches(raw)) {
            throw ConfigException("E_CONFIG", "$name must be an integer")
        }
        return raw.toIntOrNull()
            ?: throw ConfigException("E_CONFIG", "$name is outside the supported integer range")
    }

    private fun parseCapabilities(value: String): List<String> {
        val values = value.split(",")
            .map { it.trim().lowercase() }
            .filter { it.isNotEmpty() }
        if (values.isEmpty()) {
            throw ConfigException("E_CONFIG", "capabilities must contain at least one ID when present")
        }
        if (values.any { !CAPABILITY.matches(it) }) {
            throw ConfigException("E_CONFIG", "capabilities contains an invalid ID")
        }
        val normalized = values.distinct().sorted()
        if (normalized.size > MAX_CAPABILITIES) {
            throw ConfigException("E_CONFIG", "capabilities must contain at most $MAX_CAPABILITIES IDs")
        }
        return normalized
    }

    private fun validateDuration(value: String) {
        var index = 0
        var total = 0L
        if (value.isBlank()) {
            throw ConfigException("E_CONFIG", "time_range must not be empty")
        }
        while (index < value.length) {
            val match = DURATION_PART.find(value, index)
            if (match == null || match.range.first != index) {
                throw ConfigException("E_CONFIG", "time_range must be a duration such as 15m or 1h30m")
            }
            val number = match.groupValues[1].toLongOrNull()
                ?: throw ConfigException("E_CONFIG", "time_range is too large")
            val unitMillis = when (match.groupValues[2]) {
                "ms" -> 1L
                "s" -> 1_000L
                "m" -> 60_000L
                "h" -> 3_600_000L
                "d" -> 86_400_000L
                "w" -> 604_800_000L
                else -> throw ConfigException("E_CONFIG", "time_range has an unsupported unit")
            }
            total = try {
                Math.addExact(total, Math.multiplyExact(number, unitMillis))
            } catch (_: ArithmeticException) {
                throw ConfigException("E_CONFIG", "time_range is too large")
            }
            index = match.range.last + 1
        }
        if (total < 1_000L || total > 30L * 86_400_000L) {
            throw ConfigException("E_CONFIG", "time_range must be between 1s and 30d")
        }
    }

    private fun encode(value: String): String =
        URLEncoder.encode(value, StandardCharsets.UTF_8.name())
}
