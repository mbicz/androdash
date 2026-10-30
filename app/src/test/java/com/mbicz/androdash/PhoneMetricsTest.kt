package com.mbicz.androdash

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneMetricsTest {
    private val full = PhoneSnapshot(
        device = DeviceInfo("Google", "Pixel 10", "16", 36),
        battery = BatteryState(
            levelRatio = 0.85,
            charging = true,
            plugged = "ac",
            temperatureCelsius = 31.5,
            voltageVolts = 4.123,
            currentAmperes = -0.25,
            chargeAmpereHours = 3.9,
        ),
        thermalStatus = 1,
        thermalHeadroomRatio = 0.42,
        memory = MemoryState(12_000_000_000L, 5_500_000_000L, false),
        storage = StorageState(256_000_000_000L, 100_000_000_000L),
        networkReceiveBytes = 123_456_789L,
        networkTransmitBytes = 9_876_543L,
        networkType = "wifi",
        wifiRssiDbm = -55,
        wifiLinkSpeedBps = 866_000_000L,
        cpuPolicies = listOf(
            CpuPolicy("0", 1_100_000_000L, 2_000_000_000L),
            CpuPolicy("4", null, 2_600_000_000L),
            CpuPolicy("7", 3_000_000_000L, null),
        ),
        screenOn = true,
        screenBrightnessRatio = 0.5,
        uptimeSeconds = 3600.5,
        bootTimeSeconds = 1_761_600_000.0,
        processes = listOf(
            ProcessUsage("app", 200_000_000L, 12.34),
            ProcessUsage("collector", 80_000_000L, null),
        ),
        collectorRestarts = 2,
        collectorUp = true,
        scrapeDurationSeconds = 0.0125,
        sourceErrors = PhoneMetrics.SOURCES.map { it to if (it == "cpu") 3L else 0L },
    )

    @Test
    fun `full snapshot is deterministic exposition text`() {
        val text = PhoneMetrics.format(full)
        assertEquals(text, PhoneMetrics.format(full.copy()))
        val samples = text.lines().filter { it.isNotEmpty() && !it.startsWith("#") }
        assertEquals(
            listOf(
                "android_device_info{manufacturer=\"Google\",model=\"Pixel 10\",release=\"16\",sdk=\"36\"} 1",
                "android_battery_level_ratio 0.85",
                "android_battery_charging 1",
                "android_battery_plugged{source=\"ac\"} 1",
                "android_battery_temperature_celsius 31.5",
                "android_battery_voltage_volts 4.123",
                "android_battery_current_amperes -0.25",
                "android_battery_charge_ampere_hours 3.9",
                "android_thermal_status 1",
                "android_thermal_headroom_ratio 0.42",
                "android_memory_total_bytes 12000000000",
                "android_memory_available_bytes 5500000000",
                "android_memory_low 0",
                "android_storage_total_bytes 256000000000",
                "android_storage_available_bytes 100000000000",
                "android_network_receive_bytes_total 123456789",
                "android_network_transmit_bytes_total 9876543",
                "android_network_type{type=\"wifi\"} 1",
                "android_wifi_rssi_dbm -55",
                "android_wifi_link_speed_bps 866000000",
                "android_cpu_frequency_hertz{policy=\"0\"} 1100000000",
                "android_cpu_frequency_hertz{policy=\"7\"} 3000000000",
                "android_cpu_max_frequency_hertz{policy=\"0\"} 2000000000",
                "android_cpu_max_frequency_hertz{policy=\"4\"} 2600000000",
                "android_screen_on 1",
                "android_screen_brightness_ratio 0.5",
                "android_uptime_seconds 3600.5",
                "android_boot_time_seconds 1761600000",
                "androdash_process_resident_memory_bytes{process=\"app\"} 200000000",
                "androdash_process_resident_memory_bytes{process=\"collector\"} 80000000",
                "androdash_process_cpu_seconds_total{process=\"app\"} 12.34",
                "androdash_collector_restarts_total 2",
                "androdash_collector_up 1",
                "android_exporter_scrape_duration_seconds 0.0125",
                "android_exporter_source_errors_total{source=\"device\"} 0",
                "android_exporter_source_errors_total{source=\"battery\"} 0",
                "android_exporter_source_errors_total{source=\"thermal\"} 0",
                "android_exporter_source_errors_total{source=\"memory\"} 0",
                "android_exporter_source_errors_total{source=\"storage\"} 0",
                "android_exporter_source_errors_total{source=\"network\"} 0",
                "android_exporter_source_errors_total{source=\"wifi\"} 0",
                "android_exporter_source_errors_total{source=\"cpu\"} 3",
                "android_exporter_source_errors_total{source=\"screen\"} 0",
                "android_exporter_source_errors_total{source=\"time\"} 0",
                "android_exporter_source_errors_total{source=\"process\"} 0",
                "android_exporter_source_errors_total{source=\"collector\"} 0",
            ),
            samples,
        )
        assertTrue(text.endsWith("\n"))
    }

    @Test
    fun `every family has one HELP and TYPE before its samples`() {
        val lines = PhoneMetrics.format(full).lines().filter { it.isNotEmpty() }
        val families = lines.filter { it.startsWith("# TYPE ") }.map { it.split(' ')[2] }
        assertEquals(families.distinct(), families)
        assertEquals(32, families.size)
        families.forEach { family ->
            val help = lines.indexOfFirst { it.startsWith("# HELP $family ") }
            val type = lines.indexOf(lines.first { it.startsWith("# TYPE $family ") })
            val first = lines.indexOfFirst { it.startsWith("$family ") || it.startsWith("$family{") }
            assertTrue(family, help >= 0 && help + 1 == type && type + 1 == first)
        }
        val counters = lines.filter { it.startsWith("# TYPE ") && it.endsWith(" counter") }.map { it.split(' ')[2] }
        assertEquals(
            listOf(
                "android_network_receive_bytes_total",
                "android_network_transmit_bytes_total",
                "androdash_process_cpu_seconds_total",
                "androdash_collector_restarts_total",
                "android_exporter_source_errors_total",
            ),
            counters,
        )
        assertTrue(counters.all { it.endsWith("_total") })
    }

    @Test
    fun `null fields omit their whole family`() {
        val text = PhoneMetrics.format(
            PhoneSnapshot(
                battery = BatteryState(levelRatio = 0.5),
                memory = null,
                cpuPolicies = listOf(CpuPolicy("0", null, 1_000L)),
            ),
        )
        assertEquals(
            listOf(
                "# HELP android_battery_level_ratio Battery level, 0-1.",
                "# TYPE android_battery_level_ratio gauge",
                "android_battery_level_ratio 0.5",
                "# HELP android_cpu_max_frequency_hertz Maximum frequency of each cpufreq policy.",
                "# TYPE android_cpu_max_frequency_hertz gauge",
                "android_cpu_max_frequency_hertz{policy=\"0\"} 1000",
                "",
            ),
            text.split("\n"),
        )
        assertEquals("", PhoneMetrics.format(PhoneSnapshot()))
    }

    @Test
    fun `label values are escaped`() {
        assertEquals("a\\\\b\\\"c\\nd", PhoneMetrics.escapeLabel("a\\b\"c\nd"))
        val text = PhoneMetrics.format(PhoneSnapshot(device = DeviceInfo("A\"B", "x\\y", "1\n2", 26)))
        assertTrue(
            text.contains("android_device_info{manufacturer=\"A\\\"B\",model=\"x\\\\y\",release=\"1\\n2\",sdk=\"26\"} 1\n"),
        )
        assertEquals(1, text.lines().count { it.startsWith("android_device_info") })
    }

    @Test
    fun `values format integral, fractional, and special`() {
        assertEquals("0", PhoneMetrics.formatValue(0.0))
        assertEquals("-55", PhoneMetrics.formatValue(-55.0))
        assertEquals("12000000000", PhoneMetrics.formatValue(12e9))
        assertEquals("0.85", PhoneMetrics.formatValue(0.85))
        assertEquals("1.0E15", PhoneMetrics.formatValue(1e15))
        assertEquals("NaN", PhoneMetrics.formatValue(Double.NaN))
        assertEquals("+Inf", PhoneMetrics.formatValue(Double.POSITIVE_INFINITY))
        assertEquals("-Inf", PhoneMetrics.formatValue(Double.NEGATIVE_INFINITY))
    }

    @Test
    fun `battery conversions omit unsupported readings`() {
        assertEquals("none", PhoneMetrics.plugSource(0))
        assertEquals("ac", PhoneMetrics.plugSource(1))
        assertEquals("usb", PhoneMetrics.plugSource(2))
        assertEquals("wireless", PhoneMetrics.plugSource(4))
        assertEquals("dock", PhoneMetrics.plugSource(8))
        assertNull(PhoneMetrics.plugSource(16))
        assertEquals(PhoneMetrics.PLUG_SOURCES, listOf(1, 2, 4, 8, 0).map { PhoneMetrics.plugSource(it)!! })

        assertEquals(0.5, PhoneMetrics.levelRatio(50, 100)!!, 0.0)
        assertEquals(1.0, PhoneMetrics.levelRatio(120, 100)!!, 0.0)
        assertNull(PhoneMetrics.levelRatio(-1, 100))
        assertNull(PhoneMetrics.levelRatio(50, 0))

        assertEquals(-0.5, PhoneMetrics.currentAmperes(-500_000)!!, 1e-12)
        assertEquals(1.2, PhoneMetrics.currentAmperes(1_200_000)!!, 1e-12)
        assertNull(PhoneMetrics.currentAmperes(Int.MIN_VALUE))
        assertNull(PhoneMetrics.currentAmperes(0))

        assertEquals(3.9, PhoneMetrics.chargeAmpereHours(3_900_000)!!, 1e-12)
        assertNull(PhoneMetrics.chargeAmpereHours(Int.MIN_VALUE))
        assertNull(PhoneMetrics.chargeAmpereHours(0))

        assertEquals(31.5, PhoneMetrics.temperatureCelsius(315)!!, 0.0)
        assertEquals(-2.0, PhoneMetrics.temperatureCelsius(-20)!!, 0.0)
        assertNull(PhoneMetrics.temperatureCelsius(Int.MIN_VALUE))
        assertEquals(4.2, PhoneMetrics.voltageVolts(4200)!!, 1e-12)
        assertNull(PhoneMetrics.voltageVolts(-1))
    }

    @Test
    fun `network, wifi, screen, and cpu conversions`() {
        assertEquals("vpn", PhoneMetrics.networkType(vpn = true, wifi = true, cellular = false, ethernet = false))
        assertEquals("wifi", PhoneMetrics.networkType(vpn = false, wifi = true, cellular = false, ethernet = false))
        assertEquals("cellular", PhoneMetrics.networkType(vpn = false, wifi = false, cellular = true, ethernet = false))
        assertEquals("ethernet", PhoneMetrics.networkType(vpn = false, wifi = false, cellular = false, ethernet = true))
        assertEquals("none", PhoneMetrics.networkType(vpn = false, wifi = false, cellular = false, ethernet = false))

        assertEquals(-55, PhoneMetrics.wifiRssi(-55))
        assertNull(PhoneMetrics.wifiRssi(-127))
        assertNull(PhoneMetrics.wifiRssi(0))
        assertEquals(866_000_000L, PhoneMetrics.linkSpeedBps(866))
        assertNull(PhoneMetrics.linkSpeedBps(-1))

        assertEquals(1.0, PhoneMetrics.brightnessRatio(255), 0.0)
        assertEquals(0.0, PhoneMetrics.brightnessRatio(-3), 0.0)
        assertEquals(1.0, PhoneMetrics.brightnessRatio(4095), 0.0)

        assertEquals("0", PhoneMetrics.cpuPolicy("policy0"))
        assertEquals("7", PhoneMetrics.cpuPolicy("policy7"))
        assertNull(PhoneMetrics.cpuPolicy("cpu0"))
        assertNull(PhoneMetrics.cpuPolicy("policy"))
        assertNull(PhoneMetrics.cpuPolicy("policyx"))
        assertEquals(1_804_800_000L, PhoneMetrics.kilohertzToHertz("1804800\n"))
        assertNull(PhoneMetrics.kilohertzToHertz("<unknown>"))
        assertNull(PhoneMetrics.kilohertzToHertz("-1"))
    }

    @Test
    fun `proc status and stat parse`() {
        val status = "Name:\tandrodash\nVmPeak:\t  999 kB\nVmRSS:\t  204800 kB\nThreads:\t42\n"
        assertEquals(204_800L * 1024, PhoneMetrics.residentBytes(status))
        assertNull(PhoneMetrics.residentBytes("Name:\tkthreadd\n"))

        val stat = "4242 (libprometheus.s) S 1234 4242 0 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 12 0 99 0"
        val parsed = PhoneMetrics.parseProcStat(stat)!!
        assertEquals(ProcStat("libprometheus.s", 1234, 250, 50), parsed)
        assertEquals(3.0, PhoneMetrics.cpuSeconds(parsed, 100), 1e-12)
        assertEquals(300.0, PhoneMetrics.cpuSeconds(parsed, 0), 1e-12)

        val odd = "77 (a) b (c)) R 1 77 0 0 -1 0 0 0 0 0 7 3 0 0 20 0 1 0 5 0"
        assertEquals(ProcStat("a) b (c)", 1, 7, 3), PhoneMetrics.parseProcStat(odd))
        assertNull(PhoneMetrics.parseProcStat("77 (short) S 1 2 3"))
        assertNull(PhoneMetrics.parseProcStat("no parentheses"))
        assertNull(PhoneMetrics.parseProcStat("1 (x) S p 0 0 0 0 0 0 0 0 0 0 0"))
    }

    @Test
    fun `no identifier labels`() {
        val labels = Regex("\\{([^}]*)\\}").findAll(PhoneMetrics.format(full))
            .flatMap { match -> match.groupValues[1].split(',').map { it.substringBefore('=') } }
            .toSet()
        assertEquals(setOf("manufacturer", "model", "release", "sdk", "source", "type", "policy", "process"), labels)
        assertFalse(PhoneMetrics.format(full).contains("serial", ignoreCase = true))
    }
}
