package com.mbicz.androdash

import org.json.JSONObject
import org.json.JSONTokener

/**
 * One Ignition document: a single JSON object that seeds, at launch, the
 * dashboards and the collector's scrape targets a device runs with. It is
 * parsed strictly (unknown keys, wrong types, and out-of-range values are
 * rejected) and merged over the persisted config; the renderer never sees it.
 *
 * [inlineUrls] is filled by `MainActivity` after it stores [inlineDashboards]
 * with [InlineDashboards], so [Ignition.merge] stays free of file handling.
 */
data class IgnitionDocument(
    val dashboardUrls: List<String>? = null,
    val dashboardCurrent: String? = null,
    val inlineDashboards: List<String> = emptyList(),
    val inlineUrls: List<String> = emptyList(),
    val collectorEnabled: Boolean? = null,
    /** Canonical `collector_targets`, or `""` to configure none. */
    val collectorTargets: String? = null,
    val collectorPhone: Boolean? = null,
    val collectorScrapeSeconds: Int? = null,
    val collectorRetention: String? = null,
    /** Validated scalar launch extras (`prometheus_url`, `layout_mode`, ...). */
    val overrides: Map<String, String> = emptyMap(),
) {
    /** [this] with the stored inline dashboards' URLs, in document order. */
    fun withInlineUrls(urls: List<String>): IgnitionDocument = copy(inlineUrls = urls)
}

/**
 * Strict parse and merge of an Ignition document. Every field is optional; an
 * absent field keeps the persisted value. The merged config must satisfy
 * [ConfigParser.validateConfig] (including the collector rules) or the document
 * is rejected.
 *
 * Rejections carry a [ConfigException] with [CODE_INVALID] (`E_IGNITION`) and a
 * short reason; a failed `ignition_url` fetch is [CODE_FETCH]
 * (`E_IGNITION_FETCH`).
 */
object Ignition {
    /** Fatal code for a document that does not parse or merge. */
    const val CODE_INVALID = "E_IGNITION"

    /** Fatal code for a failed `ignition_url` fetch (scheme, status, size). */
    const val CODE_FETCH = "E_IGNITION_FETCH"

    /** Largest Ignition document, in bytes; also the per-inline-dashboard bound. */
    const val MAX_BYTES = DashboardStore.MAX_BYTES

    /** Most inline dashboards one document may seed. */
    const val MAX_INLINE = InlineDashboards.MAX_FILES

    private const val SCHEMA_VERSION = 1
    private const val MAX_KEY_IN_MESSAGE = 40
    private const val MIN_COLLECTOR_SCRAPE = 5
    private const val MAX_COLLECTOR_SCRAPE = 300
    private const val MIN_RETENTION_MILLIS = 3_600_000L
    private const val MAX_RETENTION_MILLIS = 30L * 86_400_000L

    private val TOP_LEVEL = setOf(
        "schemaVersion", "dashboards", "collector", "prometheusUrl", "layoutMode",
        "displayMode", "lockStyle", "refreshSeconds", "timeRange", "rotateSeconds",
        "kiosk", "debug",
    )
    private val DASHBOARD_KEYS = setOf("urls", "current", "inline")
    private val COLLECTOR_KEYS = setOf("enabled", "targets", "phone", "scrapeSeconds", "retention")

    /**
     * Parse [text] into a document. The text must be one JSON object of at most
     * [MAX_BYTES]; unknown keys anywhere in the Ignition structure, wrong types,
     * and out-of-range values are [CODE_INVALID].
     */
    fun parse(text: String): IgnitionDocument {
        if (text.length > MAX_BYTES) throw invalid("ignition exceeds $MAX_BYTES bytes")
        val root = readObject(text)
        rejectUnknown(root, TOP_LEVEL, "ignition")
        if (root.has("schemaVersion") && intField(root.get("schemaVersion"), "schemaVersion") != SCHEMA_VERSION) {
            throw invalid("schemaVersion must be $SCHEMA_VERSION")
        }

        var urls: List<String>? = null
        var current: String? = null
        var inline = emptyList<String>()
        if (root.has("dashboards")) {
            val dashboards = objectField(root.get("dashboards"), "dashboards")
            rejectUnknown(dashboards, DASHBOARD_KEYS, "dashboards")
            if (dashboards.has("urls")) {
                val array = arrayField(dashboards.get("urls"), "dashboards.urls")
                // Same rules as the `dashboard_urls` extra: each entry validated, duplicates dropped.
                val entries = (0 until array.length()).map { index ->
                    urlField(array.get(index), "dashboards.urls[$index]")
                }.distinct()
                if (entries.isEmpty()) {
                    throw invalid("dashboards.urls must hold 1 to ${ConfigParser.MAX_DASHBOARDS} URLs")
                }
                if (entries.size > ConfigParser.MAX_DASHBOARDS) {
                    throw invalid("dashboards.urls must hold at most ${ConfigParser.MAX_DASHBOARDS} URLs")
                }
                urls = entries
            }
            if (dashboards.has("current")) {
                current = urlField(dashboards.get("current"), "dashboards.current")
            }
            if (dashboards.has("inline")) {
                val array = arrayField(dashboards.get("inline"), "dashboards.inline")
                if (array.length() > MAX_INLINE) {
                    throw invalid("dashboards.inline must hold at most $MAX_INLINE documents")
                }
                inline = (0 until array.length()).map { index ->
                    val document = array.get(index) as? JSONObject
                        ?: throw invalid("dashboards.inline[$index] must be a JSON object")
                    val json = document.toString()
                    if (json.length > MAX_BYTES) {
                        throw invalid("dashboards.inline[$index] exceeds $MAX_BYTES bytes")
                    }
                    json
                }
            }
        }

        var collectorEnabled: Boolean? = null
        var collectorTargets: String? = null
        var collectorPhone: Boolean? = null
        var collectorScrapeSeconds: Int? = null
        var collectorRetention: String? = null
        if (root.has("collector")) {
            val collector = objectField(root.get("collector"), "collector")
            rejectUnknown(collector, COLLECTOR_KEYS, "collector")
            if (collector.has("enabled")) {
                collectorEnabled = boolField(collector.get("enabled"), "collector.enabled")
            }
            if (collector.has("targets")) {
                val raw = stringField(collector.get("targets"), "collector.targets", allowEmpty = true).trim()
                collectorTargets = if (raw.isEmpty()) "" else canonicalTargets(raw)
            }
            if (collector.has("phone")) {
                collectorPhone = boolField(collector.get("phone"), "collector.phone")
            }
            if (collector.has("scrapeSeconds")) {
                val value = intField(collector.get("scrapeSeconds"), "collector.scrapeSeconds")
                if (value !in MIN_COLLECTOR_SCRAPE..MAX_COLLECTOR_SCRAPE) {
                    throw invalid("collector.scrapeSeconds must be between $MIN_COLLECTOR_SCRAPE and $MAX_COLLECTOR_SCRAPE")
                }
                collectorScrapeSeconds = value
            }
            if (collector.has("retention")) {
                val raw = stringField(collector.get("retention"), "collector.retention")
                val millis = try {
                    ConfigParser.collectorRetentionMillis(raw)
                } catch (error: ConfigException) {
                    throw invalid("collector.retention: ${error.message}")
                }
                if (millis !in MIN_RETENTION_MILLIS..MAX_RETENTION_MILLIS) {
                    throw invalid("collector.retention must be between 1h and 30d")
                }
                collectorRetention = raw
            }
        }

        val overrides = LinkedHashMap<String, String>()
        if (root.has("prometheusUrl")) {
            overrides["prometheus_url"] = urlField(root.get("prometheusUrl"), "prometheusUrl")
        }
        SCALAR_STRINGS.forEach { (key, extra) ->
            if (root.has(key)) overrides[extra] = stringField(root.get(key), key)
        }
        SCALAR_INTS.forEach { (key, extra) ->
            if (root.has(key)) overrides[extra] = intField(root.get(key), key).toString()
        }
        SCALAR_BOOLEANS.forEach { (key, extra) ->
            if (root.has(key)) overrides[extra] = boolField(root.get(key), key).toString()
        }

        return IgnitionDocument(
            dashboardUrls = urls,
            dashboardCurrent = current,
            inlineDashboards = inline,
            collectorEnabled = collectorEnabled,
            collectorTargets = collectorTargets,
            collectorPhone = collectorPhone,
            collectorScrapeSeconds = collectorScrapeSeconds,
            collectorRetention = collectorRetention,
            overrides = overrides,
        )
    }

    /**
     * Apply only the fields [doc] sets to [base], then validate the result like
     * a launch (including the launch query bound). [base] is the persisted
     * config; null means nothing is persisted yet, so [doc] must name a
     * dashboard.
     *
     * Dashboards: `urls` replaces the list (then [IgnitionDocument.inlineUrls]
     * follow, duplicates dropped); `current` selects the shown dashboard and
     * must be in that list, else a given `urls` selects its first entry. Without
     * `urls`, the persisted list is kept and the shown dashboard stays the
     * persisted one unless `current` names another. `collector.targets = ""`
     * clears the targets.
     */
    fun merge(base: AppConfig?, doc: IgnitionDocument): AppConfig {
        val seed = base ?: seedBase(doc)
        val extras = LinkedHashMap<String, String?>()
        extras.putAll(doc.overrides)
        doc.collectorEnabled?.let { extras["collector"] = it.toString() }
        doc.collectorPhone?.let { extras["collector_phone"] = it.toString() }
        doc.collectorScrapeSeconds?.let { extras["collector_scrape_seconds"] = it.toString() }
        doc.collectorRetention?.let { extras["collector_retention"] = it }
        doc.collectorTargets?.takeIf { it.isNotEmpty() }?.let { extras["collector_targets"] = it }

        val parsed = try {
            ConfigParser.parse(extras, seed)
        } catch (error: ConfigException) {
            throw invalid(error.message ?: "invalid configuration")
        }
        var config = parsed.config
        if (doc.collectorTargets != null) {
            config = config.copy(collectorTargets = doc.collectorTargets.takeIf { it.isNotEmpty() })
        }

        val dashboards = doc.dashboardUrls != null || doc.dashboardCurrent != null || doc.inlineUrls.isNotEmpty()
        val urls: List<String>
        val current: String
        if (dashboards) {
            urls = ((doc.dashboardUrls ?: seed.dashboardUrls) + doc.inlineUrls).distinct()
            if (urls.size > ConfigParser.MAX_DASHBOARDS) {
                throw invalid("at most ${ConfigParser.MAX_DASHBOARDS} dashboards including inline")
            }
            current = doc.dashboardCurrent
                ?: if (doc.dashboardUrls != null || base == null) urls.first() else seed.dashboardUrl
            if (current !in urls) throw invalid("dashboards.current must be one of the dashboards")
        } else {
            urls = seed.dashboardUrls
            current = seed.dashboardUrl
        }
        config = config.copy(dashboardUrls = urls, dashboardUrl = current)

        try {
            ConfigParser.validateLaunch(config)
        } catch (error: ConfigException) {
            throw invalid(error.message ?: "invalid configuration")
        }
        return config
    }

    /**
     * The base for a device with nothing persisted: launch defaults plus the
     * dashboard [doc] names. [CODE_INVALID] when [doc] names none.
     */
    fun seedBase(doc: IgnitionDocument): AppConfig {
        val first = doc.dashboardUrls?.firstOrNull() ?: doc.inlineUrls.firstOrNull()
            ?: throw invalid("ignition needs dashboards.urls when nothing is persisted")
        return AppConfig(dashboardUrl = first)
    }

    private val SCALAR_STRINGS = mapOf(
        "layoutMode" to "layout_mode",
        "displayMode" to "display_mode",
        "lockStyle" to "lock_style",
        "timeRange" to "time_range",
    )
    private val SCALAR_INTS = mapOf(
        "refreshSeconds" to "refresh_seconds",
        "rotateSeconds" to "rotate_seconds",
    )
    private val SCALAR_BOOLEANS = mapOf(
        "kiosk" to "kiosk",
        "debug" to "debug",
    )

    private fun readObject(text: String): JSONObject {
        val value = try {
            val tokener = JSONTokener(text)
            val parsed = tokener.nextValue()
            if (tokener.nextClean() != 0.toChar()) null else parsed
        } catch (_: Exception) {
            null
        }
        return value as? JSONObject ?: throw invalid("ignition must be a single JSON object")
    }

    private fun rejectUnknown(json: JSONObject, allowed: Set<String>, name: String) {
        for (key in json.keys()) {
            if (key !in allowed) throw invalid("$name has an unknown key ${key.take(MAX_KEY_IN_MESSAGE)}")
        }
    }

    private fun objectField(value: Any?, name: String): JSONObject =
        value as? JSONObject ?: throw invalid("$name must be an object")

    private fun arrayField(value: Any?, name: String): org.json.JSONArray =
        value as? org.json.JSONArray ?: throw invalid("$name must be an array")

    private fun stringField(value: Any?, name: String, allowEmpty: Boolean = false): String {
        val text = value as? String ?: throw invalid("$name must be a string")
        if (!allowEmpty && text.isBlank()) throw invalid("$name must not be empty")
        return text
    }

    private fun urlField(value: Any?, name: String): String =
        try {
            ConfigParser.validateHttpUrl(stringField(value, name), name)
        } catch (error: ConfigException) {
            throw invalid("$name: ${error.message}")
        }

    private fun boolField(value: Any?, name: String): Boolean =
        value as? Boolean ?: throw invalid("$name must be true or false")

    private fun intField(value: Any?, name: String): Int {
        val number = value as? Number ?: throw invalid("$name must be an integer")
        val double = number.toDouble()
        if (!double.isFinite() || double != Math.floor(double)) throw invalid("$name must be an integer")
        if (double < Int.MIN_VALUE || double > Int.MAX_VALUE) {
            throw invalid("$name is outside the supported integer range")
        }
        return number.toInt()
    }

    private fun canonicalTargets(raw: String): String =
        try {
            CollectorConfig.canonicalTargets(CollectorConfig.parseTargets(raw))
        } catch (error: ConfigException) {
            throw invalid("collector.targets: ${error.message}")
        }

    private fun invalid(reason: String): ConfigException = ConfigException(CODE_INVALID, reason)
}
