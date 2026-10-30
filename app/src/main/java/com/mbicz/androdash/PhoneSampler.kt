package com.mbicz.androdash

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.TrafficStats
import android.net.wifi.WifiInfo
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.os.StatFs
import android.os.SystemClock
import android.provider.Settings
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.util.concurrent.atomic.AtomicLongArray

/**
 * Reads the phone's state for one [PhoneExporter] scrape with cheap framework
 * calls and small `/proc`/`/sys` files. Each source runs in its own try/catch:
 * a failure drops only that source's metrics and counts in
 * `android_exporter_source_errors_total`. Not thread-safe; the exporter's one
 * server thread calls [snapshot].
 */
class PhoneSampler(context: Context, private val collector: () -> CollectorRuntime) {
    private val context = context.applicationContext
    private val errors = AtomicLongArray(PhoneMetrics.SOURCES.size)
    private val ticksPerSecond: Long = try {
        Os.sysconf(OsConstants._SC_CLK_TCK).takeIf { it > 0 } ?: DEFAULT_CLOCK_TICKS
    } catch (_: Exception) {
        DEFAULT_CLOCK_TICKS
    }
    private var collectorPid: Int? = null
    private var collectorPidStartedAt: Long? = null

    fun snapshot(): PhoneSnapshot {
        val started = SystemClock.elapsedRealtimeNanos()
        val device = source("device") {
            DeviceInfo(
                manufacturer = Build.MANUFACTURER.orEmpty(),
                model = Build.MODEL.orEmpty(),
                release = Build.VERSION.RELEASE.orEmpty(),
                sdk = Build.VERSION.SDK_INT,
            )
        }
        val battery = source("battery", ::battery)
        val power = context.getSystemService(PowerManager::class.java)
        val thermal = source("thermal") { thermal(power) }
        val memory = source("memory", ::memory)
        val storage = source("storage") {
            val stat = StatFs(context.filesDir.path)
            StorageState(stat.totalBytes, stat.availableBytes)
        }
        val network = source("network", ::network)
        val wifi = source("wifi") { network?.capabilities?.let(::wifi) }
        val cpu = source("cpu", ::cpuPolicies)
        val screen = source("screen") { screen(power) }
        val time = source("time") {
            val now = System.currentTimeMillis()
            val uptime = SystemClock.elapsedRealtime()
            uptime / 1000.0 to ((now - uptime) / 1000).toDouble()
        }
        val processes = source("process", ::processes)
        val runtime = source("collector") { collector() }
        val snapshot = PhoneSnapshot(
            device = device,
            battery = battery,
            thermalStatus = thermal?.first,
            thermalHeadroomRatio = thermal?.second,
            memory = memory,
            storage = storage,
            networkReceiveBytes = network?.receiveBytes,
            networkTransmitBytes = network?.transmitBytes,
            networkType = network?.type,
            wifiRssiDbm = wifi?.first,
            wifiLinkSpeedBps = wifi?.second,
            cpuPolicies = cpu.orEmpty(),
            screenOn = screen?.first,
            screenBrightnessRatio = screen?.second,
            uptimeSeconds = time?.first,
            bootTimeSeconds = time?.second,
            processes = processes.orEmpty(),
            collectorRestarts = runtime?.restarts,
            collectorUp = runtime?.running,
        )
        return snapshot.copy(
            scrapeDurationSeconds = (SystemClock.elapsedRealtimeNanos() - started) / 1e9,
            sourceErrors = PhoneMetrics.SOURCES.mapIndexed { index, name -> name to errors.get(index) },
        )
    }

    private inline fun <T> source(name: String, block: () -> T): T? = try {
        block()
    } catch (_: Exception) {
        errors.incrementAndGet(PhoneMetrics.SOURCES.indexOf(name))
        null
    }

    private fun battery(): BatteryState {
        // ACTION_BATTERY_CHANGED is sticky: a null receiver returns the last broadcast.
        val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            ?: throw IllegalStateException("no battery broadcast")
        val manager = context.getSystemService(BatteryManager::class.java)
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1)
        return BatteryState(
            levelRatio = PhoneMetrics.levelRatio(
                intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1),
                intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1),
            ),
            charging = if (status < 0) null else status == BatteryManager.BATTERY_STATUS_CHARGING,
            plugged = if (plugged < 0) null else PhoneMetrics.plugSource(plugged),
            temperatureCelsius = PhoneMetrics.temperatureCelsius(
                intent.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE),
            ),
            voltageVolts = PhoneMetrics.voltageVolts(intent.getIntExtra(BatteryManager.EXTRA_VOLTAGE, -1)),
            currentAmperes = manager?.let {
                PhoneMetrics.currentAmperes(it.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW))
            },
            chargeAmpereHours = manager?.let {
                PhoneMetrics.chargeAmpereHours(it.getIntProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER))
            },
        )
    }

    /** Thermal status (API 29+) and 10 s headroom (API 30+, null when NaN). */
    private fun thermal(power: PowerManager?): Pair<Int?, Double?>? {
        if (power == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        val status = power.currentThermalStatus
        val headroom = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            power.getThermalHeadroom(HEADROOM_FORECAST_SECONDS).toDouble().takeUnless { it.isNaN() }
        } else {
            null
        }
        return status to headroom
    }

    private fun memory(): MemoryState? {
        val manager = context.getSystemService(ActivityManager::class.java) ?: return null
        val info = ActivityManager.MemoryInfo()
        manager.getMemoryInfo(info)
        return MemoryState(info.totalMem, info.availMem, info.lowMemory)
    }

    private class NetworkState(
        val receiveBytes: Long?,
        val transmitBytes: Long?,
        val type: String,
        val capabilities: NetworkCapabilities?,
    )

    private fun network(): NetworkState {
        val rx = TrafficStats.getTotalRxBytes().takeIf { it != TrafficStats.UNSUPPORTED.toLong() }
        val tx = TrafficStats.getTotalTxBytes().takeIf { it != TrafficStats.UNSUPPORTED.toLong() }
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val capabilities = manager?.activeNetwork?.let(manager::getNetworkCapabilities)
        val type = if (capabilities == null) {
            "none"
        } else {
            PhoneMetrics.networkType(
                vpn = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN),
                wifi = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
                cellular = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR),
                ethernet = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET),
            )
        }
        return NetworkState(rx, tx, type, capabilities)
    }

    /**
     * RSSI and link speed from the active Wi-Fi network's [WifiInfo] (API 31+).
     * The redacted `WifiInfo` needs no location permission; null otherwise.
     */
    private fun wifi(capabilities: NetworkCapabilities): Pair<Int?, Long?>? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null
        if (!capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return null
        val info = capabilities.transportInfo as? WifiInfo ?: return null
        return PhoneMetrics.wifiRssi(info.rssi) to PhoneMetrics.linkSpeedBps(info.linkSpeed)
    }

    /** cpufreq policies; unreadable directories or files are skipped. */
    private fun cpuPolicies(): List<CpuPolicy> {
        val names = File(CPUFREQ_DIR).list() ?: return emptyList()
        return names.mapNotNull { name -> PhoneMetrics.cpuPolicy(name)?.let { it to name } }
            .sortedBy { it.first.toInt() }
            .map { (policy, name) ->
                CpuPolicy(
                    policy = policy,
                    currentHertz = readKilohertz(File(CPUFREQ_DIR, "$name/scaling_cur_freq")),
                    maxHertz = readKilohertz(File(CPUFREQ_DIR, "$name/cpuinfo_max_freq")),
                )
            }
            .filter { it.currentHertz != null || it.maxHertz != null }
    }

    private fun readKilohertz(file: File): Long? = try {
        PhoneMetrics.kilohertzToHertz(file.readText())
    } catch (_: Exception) {
        null
    }

    private fun screen(power: PowerManager?): Pair<Boolean?, Double?> {
        val brightness = try {
            PhoneMetrics.brightnessRatio(
                Settings.System.getInt(context.contentResolver, Settings.System.SCREEN_BRIGHTNESS),
            )
        } catch (_: Settings.SettingNotFoundException) {
            null
        }
        return power?.isInteractive to brightness
    }

    private fun processes(): List<ProcessUsage> {
        val app = usage("app", "self")
        val pid = findCollectorPid(collector())
        val prometheus = pid?.let { usage("collector", it.toString()) }
        return listOfNotNull(app, prometheus)
    }

    private fun usage(process: String, pid: String): ProcessUsage? {
        val resident = readText("/proc/$pid/status")?.let(PhoneMetrics::residentBytes)
        val cpu = readText("/proc/$pid/stat")?.let(PhoneMetrics::parseProcStat)
            ?.let { PhoneMetrics.cpuSeconds(it, ticksPerSecond) }
        if (resident == null && cpu == null) return null
        return ProcessUsage(process, resident, cpu)
    }

    /**
     * The running Prometheus child's pid: a `/proc` entry whose parent is this
     * process and whose command is `libprometheus.so` (truncated to 15
     * characters). Cached per collector start.
     */
    private fun findCollectorPid(runtime: CollectorRuntime): Int? {
        if (!runtime.running) {
            collectorPid = null
            collectorPidStartedAt = null
            return null
        }
        val cached = collectorPid
        if (cached != null && collectorPidStartedAt == runtime.startedAt && File("/proc/$cached").exists()) {
            return cached
        }
        val self = android.os.Process.myPid()
        val found = File("/proc").list().orEmpty().asSequence()
            .mapNotNull { it.toIntOrNull() }
            .filter { it != self }
            .firstOrNull { pid ->
                readText("/proc/$pid/stat")?.let(PhoneMetrics::parseProcStat)
                    ?.let { it.ppid == self && it.comm.startsWith(COLLECTOR_COMM) } == true
            }
        collectorPid = found
        collectorPidStartedAt = runtime.startedAt
        return found
    }

    private fun readText(path: String): String? = try {
        File(path).readText()
    } catch (_: Exception) {
        null
    }

    private companion object {
        const val DEFAULT_CLOCK_TICKS = 100L
        const val HEADROOM_FORECAST_SECONDS = 10
        const val CPUFREQ_DIR = "/sys/devices/system/cpu/cpufreq"
        const val COLLECTOR_COMM = "libprometheus"
    }
}
