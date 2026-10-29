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
    private const val MIN_COLLECTOR_SCRAPE = 5
    private const val MAX_COLLECTOR_SCRAPE = 300
    private const val MIN_COLLECTOR_RETENTION_MILLIS = 3_600_000L
    private const val MAX_DURATION_MILLIS = 30L * 86_400_000L
    /** Most dashboards in `dashboard_urls`; also the stored-copy slot count (C-001). */
    const val MAX_DASHBOARDS = 8
    private const val MIN_ROTATE = 10
    private const val MAX_ROTATE = 3600
    private const val ROTATE_MESSAGE = "rotate_seconds must be 0 or between $MIN_ROTATE and $MAX_ROTATE"
    private val BUNDLED_DASHBOARD = Regex("^http://androdash\\.local/dashboards/([A-Za-z0-9_.-]+)\\.json$")

    /** Every extra C-001/C-007 defines; any other extra does not change the launch. */
    private val LAUNCH_EXTRAS = setOf(
        "dashboard_url", "dashboard_urls", "prometheus_url", "refresh_seconds", "time_range",
        "step_seconds", "kiosk", "debug", "layout_mode", "display_mode", "lock_style",
        "dashboard_source", "dashboard_name", "capabilities", "show_unsupported", "rotate_seconds",
        "collector", "collector_targets", "collector_scrape_seconds", "collector_retention",
        "lock_task", "show_when_locked",
    )

    /** Maximum length of a `setOption` name or value (C-007). */
    const val MAX_OPTION_INPUT = 64

    /**
     * Maximum length of a `setOption` `dashboard_url` / `dashboard_urls` value
     * (C-007): dashboard URLs are longer than [MAX_OPTION_INPUT].
     */
    const val MAX_OPTION_URLS_INPUT = 2048
    private val URL_OPTIONS = setOf("dashboard_url", "dashboard_urls")
    private val INTEGER = Regex("^-?\\d+$")
    private val DURATION_PART = Regex("(\\d+)(ms|s|m|h|d|w)")

    fun parse(
        extras: Map<String, String?>,
        persisted: AppConfig? = null,
        persistedShowWhenLocked: Boolean = false,
    ): ParsedLaunch {
        val warnings = ArrayList<String>()
        val base = persisted

        val explicitUrls = when {
            extras["dashboard_urls"].isNullOrBlank() -> null
            else -> parseDashboardUrls(extras.getValue("dashboard_urls")!!)
        }
        val dashboardUrl = when {
            extras.containsKey("dashboard_url") -> {
                val raw = extras["dashboard_url"]?.trim().orEmpty()
                if (raw.isEmpty()) {
                    throw ConfigException("E_CONFIG", "dashboard_url must not be empty")
                }
                validateUrl(raw, "dashboard_url")
            }
            explicitUrls != null -> explicitUrls.first()
            base != null -> validateUrl(base.dashboardUrl, "dashboard_url")
            else -> throw ConfigException("E_CONFIG", "dashboard_url is required")
        }
        // An explicit list wins; otherwise the persisted list while it still holds
        // the current dashboard; otherwise just the current dashboard.
        val dashboardUrls = withCurrent(
            dashboardUrl,
            explicitUrls
                ?: base?.dashboardUrls?.takeIf { dashboardUrl in it }
                ?: listOf(dashboardUrl),
        )

        val rotateSeconds = when {
            extras["rotate_seconds"].isNullOrBlank() -> base?.rotateSeconds ?: 0
            else -> parseRotate(extras.getValue("rotate_seconds")!!)
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

        val collector = parseBoolean(extras, "collector", base?.collector ?: false)

        val collectorTargets = when {
            !extras.containsKey("collector_targets") -> base?.collectorTargets
            extras["collector_targets"].isNullOrBlank() -> base?.collectorTargets
            else -> CollectorConfig.canonicalTargets(
                CollectorConfig.parseTargets(extras.getValue("collector_targets")!!),
            )
        }

        val collectorScrapeSeconds = when {
            !extras.containsKey("collector_scrape_seconds") ->
                base?.collectorScrapeSeconds ?: AppConfig.DEFAULT_COLLECTOR_SCRAPE_SECONDS
            extras["collector_scrape_seconds"].isNullOrBlank() ->
                base?.collectorScrapeSeconds ?: AppConfig.DEFAULT_COLLECTOR_SCRAPE_SECONDS
            else -> parseInteger(extras.getValue("collector_scrape_seconds")!!, "collector_scrape_seconds")
        }

        val collectorRetention = when {
            !extras.containsKey("collector_retention") ->
                base?.collectorRetention ?: AppConfig.DEFAULT_COLLECTOR_RETENTION
            extras["collector_retention"].isNullOrBlank() ->
                base?.collectorRetention ?: AppConfig.DEFAULT_COLLECTOR_RETENTION
            else -> extras.getValue("collector_retention")!!.trim()
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
            collector = collector,
            collectorTargets = collectorTargets,
            collectorScrapeSeconds = collectorScrapeSeconds,
            collectorRetention = collectorRetention,
            dashboardUrls = dashboardUrls,
            rotateSeconds = rotateSeconds,
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
     * True when [extras] holds any C-001/C-007 launch extra. A launcher tap or a
     * system re-start of the activity carries none (C-007 intent handling).
     */
    fun hasConfigExtras(extras: Map<String, String?>): Boolean = extras.keys.any { it in LAUNCH_EXTRAS }

    /**
     * C-007: a new intent keeps the live renderer (no reload) when it carries no
     * launch extras or resolves to the renderer URL already loaded
     * ([currentUrl], null when no renderer is live).
     */
    fun keepsRenderer(extras: Map<String, String?>, currentUrl: String?, nextUrl: String): Boolean =
        currentUrl != null && (!hasConfigExtras(extras) || nextUrl == currentUrl)

    /** Maximum `setOption` value length for [name] (C-007). */
    fun maxOptionValue(name: String?): Int =
        if (name?.trim() in URL_OPTIONS) MAX_OPTION_URLS_INPUT else MAX_OPTION_INPUT

    /**
     * Apply one renderer option (C-007 `AndroDash.setOption`) to the current
     * config with the same rules as the launch extra of that name. Unknown
     * names, blank or over-long values, and invalid values are `E_CONFIG`.
     * `dashboard_url` must be one of the current `dashboard_urls`, and
     * `dashboard_urls` may only add bundled dashboards: the page never
     * introduces a remote URL.
     */
    fun applyOption(config: AppConfig, name: String?, value: String?): OptionUpdate {
        val option = name?.trim().orEmpty()
        val raw = value?.trim().orEmpty()
        if (option.length > MAX_OPTION_INPUT) {
            throw ConfigException("E_CONFIG", "setOption names must be at most $MAX_OPTION_INPUT characters")
        }
        val limit = maxOptionValue(option)
        if (raw.length > limit) {
            throw ConfigException("E_CONFIG", "setOption $option values must be at most $limit characters")
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
            "dashboard_url" -> {
                if (raw !in config.dashboardUrls) {
                    throw ConfigException("E_CONFIG", "dashboard_url must be one of dashboard_urls")
                }
                config.copy(dashboardUrl = raw)
            }
            "dashboard_urls" -> {
                val urls = parseDashboardUrls(raw)
                if (urls.any { it !in config.dashboardUrls && !isBundledDashboard(it) }) {
                    throw ConfigException("E_CONFIG", "dashboard_urls may only add bundled dashboards")
                }
                config.copy(dashboardUrls = withCurrent(config.dashboardUrl, urls))
            }
            "rotate_seconds" -> config.copy(rotateSeconds = parseRotate(raw))
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
        add("prometheus_url", rendererPrometheusUrl(config))
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
        add("dashboard_urls", config.dashboardUrls.joinToString(","))
        add("rotate_seconds", config.rotateSeconds.toString())
        return parts.joinToString("&")
    }

    fun launchUrl(config: AppConfig): String = "$LAUNCH_URL?${buildQuery(config)}"

    /**
     * The Prometheus base URL the renderer receives: the on-phone collector's
     * loopback listener when `collector=true` (C-001), else the configured one.
     */
    fun rendererPrometheusUrl(config: AppConfig): String? =
        if (config.collector) CollectorConfig.URL else config.prometheusUrl

    fun validateConfig(config: AppConfig) {
        validateUrl(config.dashboardUrl, "dashboard_url")
        validateDashboardUrls(config)
        if (config.rotateSeconds != 0 && config.rotateSeconds !in MIN_ROTATE..MAX_ROTATE) {
            throw ConfigException("E_CONFIG", ROTATE_MESSAGE)
        }
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
        if (config.collectorScrapeSeconds !in MIN_COLLECTOR_SCRAPE..MAX_COLLECTOR_SCRAPE) {
            throw ConfigException(
                "E_CONFIG",
                "collector_scrape_seconds must be between $MIN_COLLECTOR_SCRAPE and $MAX_COLLECTOR_SCRAPE",
            )
        }
        if (collectorRetentionMillis(config.collectorRetention) !in
            MIN_COLLECTOR_RETENTION_MILLIS..MAX_DURATION_MILLIS
        ) {
            throw ConfigException("E_CONFIG", "collector_retention must be between 1h and 30d")
        }
        config.collectorTargets?.let { CollectorConfig.parseTargets(it) }
        if (config.collector && config.collectorTargets == null) {
            throw ConfigException("E_CONFIG", "collector_targets is required when collector=true")
        }
    }

    /** Milliseconds of a C-001 duration given as `collector_retention`. */
    fun collectorRetentionMillis(value: String): Long = durationMillis(value, "collector_retention")

    /**
     * A bundled `http://androdash.local/dashboards/<name>.json` URL other than
     * the generated index (and without `..`, which the asset server refuses).
     */
    fun isBundledDashboard(url: String): Boolean {
        val name = BUNDLED_DASHBOARD.matchEntire(url)?.groupValues?.get(1) ?: return false
        return name != "index" && !url.contains("..")
    }

    /**
     * C-001 `dashboard_urls` list: comma-separated (a comma inside a URL is
     * written `%2C`), entries trimmed, blank entries skipped, each validated like
     * `dashboard_url`, duplicates removed keeping the first, 1–[MAX_DASHBOARDS].
     */
    private fun parseDashboardUrls(value: String): List<String> {
        val urls = value.split(",")
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .map { validateUrl(it, "dashboard_urls") }
            .distinct()
        if (urls.isEmpty()) {
            throw ConfigException("E_CONFIG", "dashboard_urls must contain at least one URL")
        }
        if (urls.size > MAX_DASHBOARDS) {
            throw ConfigException("E_CONFIG", "dashboard_urls must contain at most $MAX_DASHBOARDS URLs")
        }
        return urls
    }

    /** [urls] with [current] inserted first when it is missing; at most [MAX_DASHBOARDS]. */
    private fun withCurrent(current: String, urls: List<String>): List<String> {
        val all = if (current in urls) urls else listOf(current) + urls
        if (all.size > MAX_DASHBOARDS) {
            throw ConfigException(
                "E_CONFIG",
                "dashboard_urls must contain at most $MAX_DASHBOARDS URLs including dashboard_url",
            )
        }
        return all
    }

    private fun validateDashboardUrls(config: AppConfig) {
        val urls = config.dashboardUrls
        if (urls.isEmpty() || urls.size > MAX_DASHBOARDS) {
            throw ConfigException("E_CONFIG", "dashboard_urls must contain 1 to $MAX_DASHBOARDS URLs")
        }
        urls.forEach {
            validateUrl(it, "dashboard_urls")
            if (it.contains(',')) {
                throw ConfigException("E_CONFIG", "dashboard_urls entries must write a comma as %2C")
            }
        }
        if (urls.distinct().size != urls.size) {
            throw ConfigException("E_CONFIG", "dashboard_urls contains duplicate URLs")
        }
        if (config.dashboardUrl !in urls) {
            throw ConfigException("E_CONFIG", "dashboard_url must be one of dashboard_urls")
        }
    }

    /** `0` = off, else `10–3600` (C-001 `rotate_seconds`). */
    private fun parseRotate(value: String): Int {
        val parsed = parseInteger(value, "rotate_seconds")
        if (parsed != 0 && parsed !in MIN_ROTATE..MAX_ROTATE) {
            throw ConfigException("E_CONFIG", ROTATE_MESSAGE)
        }
        return parsed
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
        val total = durationMillis(value, "time_range")
        if (total < 1_000L || total > MAX_DURATION_MILLIS) {
            throw ConfigException("E_CONFIG", "time_range must be between 1s and 30d")
        }
    }

    /** C-001 duration grammar (`15m`, `1h30m`, `7d`): one or more `<n><unit>` parts. */
    private fun durationMillis(value: String, name: String): Long {
        var index = 0
        var total = 0L
        if (value.isBlank()) {
            throw ConfigException("E_CONFIG", "$name must not be empty")
        }
        while (index < value.length) {
            val match = DURATION_PART.find(value, index)
            if (match == null || match.range.first != index) {
                throw ConfigException("E_CONFIG", "$name must be a duration such as 15m or 1h30m")
            }
            val number = match.groupValues[1].toLongOrNull()
                ?: throw ConfigException("E_CONFIG", "$name is too large")
            val unitMillis = when (match.groupValues[2]) {
                "ms" -> 1L
                "s" -> 1_000L
                "m" -> 60_000L
                "h" -> 3_600_000L
                "d" -> 86_400_000L
                "w" -> 604_800_000L
                else -> throw ConfigException("E_CONFIG", "$name has an unsupported unit")
            }
            total = try {
                Math.addExact(total, Math.multiplyExact(number, unitMillis))
            } catch (_: ArithmeticException) {
                throw ConfigException("E_CONFIG", "$name is too large")
            }
            index = match.range.last + 1
        }
        return total
    }

    private fun encode(value: String): String =
        URLEncoder.encode(value, StandardCharsets.UTF_8.name())
}
