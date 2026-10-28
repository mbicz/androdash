package com.mbicz.androdash

import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

class ConfigException(
    val code: String,
    message: String,
) : IllegalArgumentException(message)

/**
 * [showWhenLockedPreference] is the operator's persisted choice (the extra,
 * else the stored value); [showWhenLocked] is the effective value, gated by
 * `kiosk` (C-007).
 */
data class ParsedLaunch(
    val config: AppConfig,
    val lockTask: Boolean,
    val showWhenLocked: Boolean,
    val showWhenLockedPreference: Boolean,
    val warnings: List<String>,
)

/** Result of a renderer `AndroDash.setOption` request (C-007). */
data class OptionUpdate(
    val config: AppConfig,
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
    private val LAYOUTS = setOf("auto", "grid", "stack", "fit")
    private val DISPLAY_MODES = setOf("standard", "amoled", "monochrome")
    private val LOCK_STYLES = setOf("monochrome", "color")
    private val DASHBOARD_SOURCES = setOf("stored", "url")

    /** Maximum length of a `setOption` name or value (C-007). */
    const val MAX_OPTION_INPUT = 64
    private val INTEGER = Regex("^-?\\d+$")
    private val DURATION_PART = Regex("(\\d+)(ms|s|m|h|d|w)")

    fun parse(
        extras: Map<String, String?>,
        persisted: AppConfig? = null,
        persistedShowWhenLocked: Boolean = false,
    ): ParsedLaunch {
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
            else -> parseRefresh(extras.getValue("refresh_seconds")!!, warnings)
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
            else -> parseEnum(extras.getValue("layout_mode")!!, "layout_mode", LAYOUTS)
        }

        val displayMode = when {
            !extras.containsKey("display_mode") -> base?.displayMode ?: "standard"
            extras["display_mode"].isNullOrBlank() -> base?.displayMode ?: "standard"
            else -> parseEnum(extras.getValue("display_mode")!!, "display_mode", DISPLAY_MODES)
        }

        val lockStyle = when {
            !extras.containsKey("lock_style") -> base?.lockStyle ?: "monochrome"
            extras["lock_style"].isNullOrBlank() -> base?.lockStyle ?: "monochrome"
            else -> parseEnum(extras.getValue("lock_style")!!, "lock_style", LOCK_STYLES)
        }

        val dashboardSource = when {
            !extras.containsKey("dashboard_source") -> base?.dashboardSource ?: "stored"
            extras["dashboard_source"].isNullOrBlank() -> base?.dashboardSource ?: "stored"
            else -> parseEnum(extras.getValue("dashboard_source")!!, "dashboard_source", DASHBOARD_SOURCES)
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
            lockStyle = lockStyle,
            dashboardSource = dashboardSource,
            dashboardName = dashboardName,
            capabilities = capabilities,
            showUnsupported = showUnsupported,
        )
        validateConfig(config)
        validateQueryLength(config)

        val requestedLockTask = parseBoolean(extras, "lock_task", false)
        val showWhenLockedPreference =
            parseBoolean(extras, "show_when_locked", persistedShowWhenLocked)
        return ParsedLaunch(
            config = config,
            lockTask = kiosk && requestedLockTask,
            showWhenLocked = kiosk && showWhenLockedPreference,
            showWhenLockedPreference = showWhenLockedPreference,
            warnings = warnings,
        )
    }

    /**
     * Apply one renderer option (C-007 `AndroDash.setOption`) to the current
     * config with the same rules as the launch extra of that name. Unknown
     * names, blank or over-long values, and invalid values are `E_CONFIG`.
     */
    fun applyOption(config: AppConfig, name: String?, value: String?): OptionUpdate {
        val option = name?.trim().orEmpty()
        val raw = value?.trim().orEmpty()
        if (option.length > MAX_OPTION_INPUT || raw.length > MAX_OPTION_INPUT) {
            throw ConfigException("E_CONFIG", "setOption inputs must be at most $MAX_OPTION_INPUT characters")
        }
        if (raw.isEmpty()) {
            throw ConfigException("E_CONFIG", "setOption needs a value")
        }
        val warnings = ArrayList<String>()
        val updated = when (option) {
            "time_range" -> {
                validateDuration(raw)
                config.copy(timeRange = raw)
            }
            "refresh_seconds" -> config.copy(refreshSeconds = parseRefresh(raw, warnings))
            "layout_mode" -> config.copy(layoutMode = parseEnum(raw, "layout_mode", LAYOUTS))
            "lock_style" -> config.copy(lockStyle = parseEnum(raw, "lock_style", LOCK_STYLES))
            "dashboard_source" -> config.copy(
                dashboardSource = parseEnum(raw, "dashboard_source", DASHBOARD_SOURCES),
            )
            else -> throw ConfigException("E_CONFIG", "setOption does not accept this option name")
        }
        validateConfig(updated)
        validateQueryLength(updated)
        return OptionUpdate(updated, warnings)
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
        add("lock_style", config.lockStyle)
        add("dashboard_source", config.dashboardSource)
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
            throw ConfigException("E_CONFIG", enumMessage("layout_mode", LAYOUTS))
        }
        if (config.displayMode !in DISPLAY_MODES) {
            throw ConfigException("E_CONFIG", enumMessage("display_mode", DISPLAY_MODES))
        }
        if (config.lockStyle !in LOCK_STYLES) {
            throw ConfigException("E_CONFIG", enumMessage("lock_style", LOCK_STYLES))
        }
        if (config.dashboardSource !in DASHBOARD_SOURCES) {
            throw ConfigException("E_CONFIG", enumMessage("dashboard_source", DASHBOARD_SOURCES))
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

    private fun parseEnum(value: String, name: String, allowed: Set<String>): String {
        val normalized = value.trim().lowercase()
        if (normalized !in allowed) {
            throw ConfigException("E_CONFIG", enumMessage(name, allowed))
        }
        return normalized
    }

    private fun enumMessage(name: String, allowed: Set<String>): String =
        "$name must be one of ${allowed.joinToString(", ")}"

    /** `0` = manual, `1–4` clamps to `5` with `W_REFRESH_CLAMPED`, max [MAX_REFRESH] (C-001). */
    private fun parseRefresh(value: String, warnings: MutableList<String>): Int {
        val parsed = parseInteger(value, "refresh_seconds")
        if (parsed < 0 || parsed > MAX_REFRESH) {
            throw ConfigException("E_CONFIG", "refresh_seconds must be between 0 and $MAX_REFRESH")
        }
        if (parsed in 1..4) {
            warnings.add("W_REFRESH_CLAMPED: refresh_seconds raised to 5")
            return 5
        }
        return parsed
    }

    private fun validateQueryLength(config: AppConfig) {
        if (buildQuery(config).length > MAX_QUERY) {
            throw ConfigException("E_CONFIG", "Launch query string exceeds $MAX_QUERY characters")
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
