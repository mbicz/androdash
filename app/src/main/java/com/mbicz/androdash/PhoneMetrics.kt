package com.mbicz.androdash

/** `android_device_info` labels; build constants, no identifiers. */
data class DeviceInfo(
    val manufacturer: String,
    val model: String,
    val release: String,
    val sdk: Int,
)

/** Battery readings; each null field is omitted from the exposition. */
data class BatteryState(
    val levelRatio: Double? = null,
    val charging: Boolean? = null,
    /** One of [PhoneMetrics.PLUG_SOURCES], or null when unknown. */
    val plugged: String? = null,
    val temperatureCelsius: Double? = null,
    val voltageVolts: Double? = null,
    val currentAmperes: Double? = null,
    val chargeAmpereHours: Double? = null,
)

data class MemoryState(val totalBytes: Long, val availableBytes: Long, val low: Boolean)

data class StorageState(val totalBytes: Long, val availableBytes: Long)

/** One cpufreq policy; [policy] is the number of its `policyN` directory. */
data class CpuPolicy(val policy: String, val currentHertz: Long?, val maxHertz: Long?)

/** One AndroDash process (`app` or `collector`). */
data class ProcessUsage(val process: String, val residentBytes: Long?, val cpuSeconds: Double?)

/** `/proc/<pid>/stat` fields the exporter needs. */
data class ProcStat(val comm: String, val ppid: Int, val utimeTicks: Long, val stimeTicks: Long)

/**
 * One scrape's phone state (C-008 "Phone exporter"). A null field or empty list
 * means the source failed or the value is unsupported: its metric family is
 * omitted, never reported as zero.
 */
data class PhoneSnapshot(
    val device: DeviceInfo? = null,
    val battery: BatteryState? = null,
    val thermalStatus: Int? = null,
    val thermalHeadroomRatio: Double? = null,
    val memory: MemoryState? = null,
    val storage: StorageState? = null,
    val networkReceiveBytes: Long? = null,
    val networkTransmitBytes: Long? = null,
    /** One of [PhoneMetrics.NETWORK_TYPES]. */
    val networkType: String? = null,
    val wifiRssiDbm: Int? = null,
    val wifiLinkSpeedBps: Long? = null,
    val cpuPolicies: List<CpuPolicy> = emptyList(),
    val screenOn: Boolean? = null,
    val screenBrightnessRatio: Double? = null,
    val uptimeSeconds: Double? = null,
    val bootTimeSeconds: Double? = null,
    val processes: List<ProcessUsage> = emptyList(),
    val collectorRestarts: Int? = null,
    val collectorUp: Boolean? = null,
    val scrapeDurationSeconds: Double? = null,
    /** Cumulative failures per source, in [PhoneMetrics.SOURCES] order. */
    val sourceErrors: List<Pair<String, Long>> = emptyList(),
)

/**
 * Pure Prometheus text exposition (format 0.0.4) of a [PhoneSnapshot] plus the
 * unit conversions of raw Android readings. Families appear in a fixed order,
 * each with `# HELP` and `# TYPE`; a family without samples is omitted.
 */
object PhoneMetrics {
    const val CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"

    /** Sampling sources; the `source` label of `android_exporter_source_errors_total`. */
    val SOURCES = listOf(
        "device", "battery", "thermal", "memory", "storage", "network",
        "wifi", "cpu", "screen", "time", "process", "collector",
    )
    val PLUG_SOURCES = listOf("ac", "usb", "wireless", "dock", "none")
    val NETWORK_TYPES = listOf("wifi", "cellular", "ethernet", "vpn", "none")

    private const val PLUGGED_AC = 1
    private const val PLUGGED_USB = 2
    private const val PLUGGED_WIRELESS = 4
    private const val PLUGGED_DOCK = 8
    private const val MAX_RSSI = -1
    private const val MIN_RSSI = -126
    private val POLICY_DIR = Regex("^policy([0-9]{1,4})$")
    private val VM_RSS = Regex("^VmRSS:\\s*([0-9]+)\\s*kB\\s*$")

    fun format(snapshot: PhoneSnapshot): String {
        val out = Exposition()
        with(snapshot) {
            out.family(
                "android_device_info", "gauge",
                "Device build: manufacturer, model, Android release and SDK level.",
                device?.let {
                    listOf(
                        labels(
                            "manufacturer" to it.manufacturer,
                            "model" to it.model,
                            "release" to it.release,
                            "sdk" to it.sdk.toString(),
                        ) to 1.0,
                    )
                },
            )
            out.gauge("android_battery_level_ratio", "Battery level, 0-1.", battery?.levelRatio)
            out.gauge("android_battery_charging", "1 while the battery is charging.", battery?.charging?.toDouble())
            out.family(
                "android_battery_plugged", "gauge",
                "1 for the current power source: ac, usb, wireless, dock, or none.",
                battery?.plugged?.let { listOf(labels("source" to it) to 1.0) },
            )
            out.gauge("android_battery_temperature_celsius", "Battery temperature.", battery?.temperatureCelsius)
            out.gauge("android_battery_voltage_volts", "Battery voltage.", battery?.voltageVolts)
            out.gauge(
                "android_battery_current_amperes",
                "Instantaneous battery current as reported by the device (sign is device-specific).",
                battery?.currentAmperes,
            )
            out.gauge("android_battery_charge_ampere_hours", "Remaining battery charge.", battery?.chargeAmpereHours)
            out.gauge(
                "android_thermal_status",
                "PowerManager thermal status: 0 none, 1 light, 2 moderate, 3 severe, 4 critical, 5 emergency, 6 shutdown.",
                thermalStatus?.toDouble(),
            )
            out.gauge(
                "android_thermal_headroom_ratio",
                "Thermal headroom forecast for 10 s; 1.0 is the severe throttling threshold.",
                thermalHeadroomRatio,
            )
            out.gauge("android_memory_total_bytes", "Total RAM available to the kernel.", memory?.totalBytes?.toDouble())
            out.gauge("android_memory_available_bytes", "RAM available to apps.", memory?.availableBytes?.toDouble())
            out.gauge("android_memory_low", "1 when the system considers memory low.", memory?.low?.toDouble())
            out.gauge("android_storage_total_bytes", "Size of the app data volume.", storage?.totalBytes?.toDouble())
            out.gauge(
                "android_storage_available_bytes",
                "Free space on the app data volume available to apps.",
                storage?.availableBytes?.toDouble(),
            )
            out.counter(
                "android_network_receive_bytes_total",
                "Bytes received on all interfaces since boot.",
                networkReceiveBytes?.toDouble(),
            )
            out.counter(
                "android_network_transmit_bytes_total",
                "Bytes transmitted on all interfaces since boot.",
                networkTransmitBytes?.toDouble(),
            )
            out.family(
                "android_network_type", "gauge",
                "1 for the active network's transport: wifi, cellular, ethernet, vpn, or none.",
                networkType?.let { listOf(labels("type" to it) to 1.0) },
            )
            out.gauge("android_wifi_rssi_dbm", "Signal strength of the active Wi-Fi network.", wifiRssiDbm?.toDouble())
            out.gauge(
                "android_wifi_link_speed_bps",
                "Link speed of the active Wi-Fi network in bits per second.",
                wifiLinkSpeedBps?.toDouble(),
            )
            out.family(
                "android_cpu_frequency_hertz", "gauge",
                "Current frequency of each cpufreq policy.",
                cpuPolicies.mapNotNull { policy ->
                    policy.currentHertz?.let { labels("policy" to policy.policy) to it.toDouble() }
                },
            )
            out.family(
                "android_cpu_max_frequency_hertz", "gauge",
                "Maximum frequency of each cpufreq policy.",
                cpuPolicies.mapNotNull { policy ->
                    policy.maxHertz?.let { labels("policy" to policy.policy) to it.toDouble() }
                },
            )
            out.gauge("android_screen_on", "1 while the device is interactive (screen on).", screenOn?.toDouble())
            out.gauge(
                "android_screen_brightness_ratio",
                "Screen brightness setting, 0-1.",
                screenBrightnessRatio,
            )
            out.gauge("android_uptime_seconds", "Time since boot, including deep sleep.", uptimeSeconds)
            out.gauge("android_boot_time_seconds", "Boot time, unix seconds.", bootTimeSeconds)
            out.family(
                "androdash_process_resident_memory_bytes", "gauge",
                "Resident memory of the AndroDash app process and its collector.",
                processes.mapNotNull { usage ->
                    usage.residentBytes?.let { labels("process" to usage.process) to it.toDouble() }
                },
            )
            out.family(
                "androdash_process_cpu_seconds_total", "counter",
                "User plus system CPU time of the AndroDash app process and its collector.",
                processes.mapNotNull { usage ->
                    usage.cpuSeconds?.let { labels("process" to usage.process) to it }
                },
            )
            out.counter(
                "androdash_collector_restarts_total",
                "Collector restarts since the current collector configuration started.",
                collectorRestarts?.toDouble(),
            )
            out.gauge("androdash_collector_up", "1 while the on-phone Prometheus process runs.", collectorUp?.toDouble())
            out.gauge(
                "android_exporter_scrape_duration_seconds",
                "Time spent sampling this scrape.",
                scrapeDurationSeconds,
            )
            out.family(
                "android_exporter_source_errors_total", "counter",
                "Failed samplings per source since the exporter started.",
                sourceErrors.map { (source, count) -> labels("source" to source) to count.toDouble() },
            )
        }
        return out.text()
    }

    /** Prometheus label value escaping: backslash, double quote, newline. */
    fun escapeLabel(value: String): String = buildString(value.length) {
        for (char in value) {
            when (char) {
                '\\' -> append("\\\\")
                '"' -> append("\\\"")
                '\n' -> append("\\n")
                else -> append(char)
            }
        }
    }

    /** Sample value text: integral values without a fraction, `NaN`, `+Inf`, `-Inf`. */
    fun formatValue(value: Double): String = when {
        value.isNaN() -> "NaN"
        value == Double.POSITIVE_INFINITY -> "+Inf"
        value == Double.NEGATIVE_INFINITY -> "-Inf"
        value == Math.rint(value) && Math.abs(value) < 1e15 -> value.toLong().toString()
        else -> value.toString()
    }

    /** `BatteryManager.EXTRA_PLUGGED` → plug source; null for an unknown non-zero value. */
    fun plugSource(plugged: Int): String? = when {
        plugged == 0 -> "none"
        plugged and PLUGGED_AC != 0 -> "ac"
        plugged and PLUGGED_USB != 0 -> "usb"
        plugged and PLUGGED_WIRELESS != 0 -> "wireless"
        plugged and PLUGGED_DOCK != 0 -> "dock"
        else -> null
    }

    /** `EXTRA_LEVEL`/`EXTRA_SCALE` → 0–1; null when either is missing. */
    fun levelRatio(level: Int, scale: Int): Double? =
        if (level < 0 || scale <= 0) null else (level.toDouble() / scale).coerceIn(0.0, 1.0)

    /** `BATTERY_PROPERTY_CURRENT_NOW` µA → A; null when unsupported (`Int.MIN_VALUE` or 0). */
    fun currentAmperes(microAmperes: Int): Double? =
        if (microAmperes == Int.MIN_VALUE || microAmperes == 0) null else microAmperes / 1e6

    /** `BATTERY_PROPERTY_CHARGE_COUNTER` µAh → Ah; null when unsupported. */
    fun chargeAmpereHours(microAmpereHours: Int): Double? =
        if (microAmpereHours <= 0) null else microAmpereHours / 1e6

    /** `EXTRA_TEMPERATURE` tenths of °C → °C; null when the extra is missing. */
    fun temperatureCelsius(tenths: Int): Double? = if (tenths == Int.MIN_VALUE) null else tenths / 10.0

    /** `EXTRA_VOLTAGE` mV → V; null when missing. */
    fun voltageVolts(millivolts: Int): Double? = if (millivolts <= 0) null else millivolts / 1000.0

    /** Active network transport, VPN first; `none` without an active network. */
    fun networkType(vpn: Boolean, wifi: Boolean, cellular: Boolean, ethernet: Boolean): String = when {
        vpn -> "vpn"
        wifi -> "wifi"
        cellular -> "cellular"
        ethernet -> "ethernet"
        else -> "none"
    }

    /** `WifiInfo.getRssi()`; null for the invalid -127 and other out-of-range values. */
    fun wifiRssi(rssi: Int): Int? = rssi.takeIf { it in MIN_RSSI..MAX_RSSI }

    /** `WifiInfo.getLinkSpeed()` Mbps → bit/s; null when unknown (≤ 0). */
    fun linkSpeedBps(mbps: Int): Long? = if (mbps <= 0) null else mbps * 1_000_000L

    /** `SCREEN_BRIGHTNESS` 0–255 → 0–1. */
    fun brightnessRatio(raw: Int): Double = (raw / 255.0).coerceIn(0.0, 1.0)

    /** The number of a `policyN` cpufreq directory, or null for any other name. */
    fun cpuPolicy(directoryName: String): String? = POLICY_DIR.matchEntire(directoryName)?.groupValues?.get(1)

    /** A cpufreq kHz file's text → Hz; null when it is not a non-negative integer. */
    fun kilohertzToHertz(text: String): Long? = text.trim().toLongOrNull()?.takeIf { it >= 0 }?.times(1000)

    /** `VmRSS` of a `/proc/<pid>/status` text in bytes; null when absent. */
    fun residentBytes(status: String): Long? = status.lineSequence()
        .firstNotNullOfOrNull { VM_RSS.matchEntire(it.trim())?.groupValues?.get(1)?.toLongOrNull() }
        ?.times(1024)

    /**
     * Parse `/proc/<pid>/stat`. The command name may contain spaces and
     * parentheses, so fields are counted after its last `)`.
     */
    fun parseProcStat(text: String): ProcStat? {
        val open = text.indexOf('(')
        val close = text.lastIndexOf(')')
        if (open < 0 || close < open) return null
        val fields = text.substring(close + 1).trim().split(' ').filter { it.isNotEmpty() }
        // fields[0] = state (3), [1] = ppid (4), [11] = utime (14), [12] = stime (15).
        if (fields.size < 13) return null
        return ProcStat(
            comm = text.substring(open + 1, close),
            ppid = fields[1].toIntOrNull() ?: return null,
            utimeTicks = fields[11].toLongOrNull() ?: return null,
            stimeTicks = fields[12].toLongOrNull() ?: return null,
        )
    }

    /** CPU seconds of [stat] at [ticksPerSecond] (`_SC_CLK_TCK`). */
    fun cpuSeconds(stat: ProcStat, ticksPerSecond: Long): Double =
        (stat.utimeTicks + stat.stimeTicks).toDouble() / ticksPerSecond.coerceAtLeast(1)

    private fun labels(vararg pairs: Pair<String, String>): List<Pair<String, String>> = pairs.toList()

    private fun Boolean.toDouble(): Double = if (this) 1.0 else 0.0

    private class Exposition {
        private val out = StringBuilder(4096)

        fun gauge(name: String, help: String, value: Double?) =
            family(name, "gauge", help, value?.let { listOf(emptyList<Pair<String, String>>() to it) })

        fun counter(name: String, help: String, value: Double?) =
            family(name, "counter", help, value?.let { listOf(emptyList<Pair<String, String>>() to it) })

        fun family(name: String, type: String, help: String, samples: List<Pair<List<Pair<String, String>>, Double>>?) {
            if (samples.isNullOrEmpty()) return
            out.append("# HELP ").append(name).append(' ').append(help).append('\n')
            out.append("# TYPE ").append(name).append(' ').append(type).append('\n')
            for ((labels, value) in samples) {
                out.append(name)
                if (labels.isNotEmpty()) {
                    out.append('{')
                    labels.forEachIndexed { index, (key, text) ->
                        if (index > 0) out.append(',')
                        out.append(key).append("=\"").append(escapeLabel(text)).append('"')
                    }
                    out.append('}')
                }
                out.append(' ').append(formatValue(value)).append('\n')
            }
        }

        fun text(): String = out.toString()
    }
}
