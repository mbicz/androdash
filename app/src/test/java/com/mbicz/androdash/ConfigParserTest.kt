package com.mbicz.androdash

import java.net.URLDecoder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ConfigParserTest {
    private val dashboard = "http://10.0.2.2:8099/contracts/fixtures/demo-dashboard.json"

    private fun extras(vararg values: Pair<String, String?>): Map<String, String?> =
        values.toMap()

    @Test
    fun `valid extras become the canonical config`() {
        val parsed = ConfigParser.parse(
            extras(
                "dashboard_url" to dashboard,
                "prometheus_url" to "http://10.0.2.2:9091",
                "refresh_seconds" to "10",
                "time_range" to "15m",
                "step_seconds" to "15",
                "kiosk" to "true",
                "debug" to "true",
                "layout_mode" to "stack",
                "display_mode" to "monochrome",
                "dashboard_name" to "Demo",
                "capabilities" to "Prometheus, tempo,prometheus",
                "show_unsupported" to "true",
                "lock_task" to "true",
            ),
        )
        val config = parsed.config
        assertEquals(dashboard, config.dashboardUrl)
        assertEquals("http://10.0.2.2:9091", config.prometheusUrl)
        assertEquals(10, config.refreshSeconds)
        assertEquals("15m", config.timeRange)
        assertEquals(15, config.stepSeconds)
        assertTrue(config.kiosk)
        assertTrue(config.debug)
        assertEquals("stack", config.layoutMode)
        assertEquals("monochrome", config.displayMode)
        assertEquals("Demo", config.dashboardName)
        assertEquals(listOf("prometheus", "tempo"), config.capabilities)
        assertTrue(config.showUnsupported)
        assertTrue(parsed.lockTask)
    }

    @Test
    fun `refresh 1 through 4 clamps to 5 with a warning`() {
        val parsed = ConfigParser.parse(
            extras("dashboard_url" to dashboard, "refresh_seconds" to "3"),
        )
        assertEquals(5, parsed.config.refreshSeconds)
        assertEquals(1, parsed.warnings.size)
    }

    @Test
    fun `persisted config fills absent optional extras`() {
        val persisted = AppConfig(
            dashboardUrl = dashboard,
            prometheusUrl = "http://prom:9090",
            refreshSeconds = 30,
            timeRange = "1h",
            stepSeconds = 30,
            kiosk = false,
            debug = true,
            layoutMode = "grid",
            displayMode = "amoled",
            dashboardName = "Persisted",
            capabilities = listOf("prometheus"),
            showUnsupported = true,
        )
        val parsed = ConfigParser.parse(emptyMap(), persisted)
        assertEquals(persisted, parsed.config)
        assertFalse(parsed.lockTask)
    }

    @Test
    fun `explicit extras override persisted fields`() {
        val persisted = AppConfig(
            dashboardUrl = dashboard,
            prometheusUrl = "http://old:9090",
            refreshSeconds = 30,
            kiosk = false,
        )
        val parsed = ConfigParser.parse(
            extras(
                "dashboard_url" to "https://example.com/new.json",
                "refresh_seconds" to "12",
                "kiosk" to "true",
            ),
            persisted,
        )
        assertEquals("https://example.com/new.json", parsed.config.dashboardUrl)
        assertEquals(12, parsed.config.refreshSeconds)
        assertTrue(parsed.config.kiosk)
        assertEquals("http://old:9090", parsed.config.prometheusUrl)
    }

    @Test
    fun `empty optional extras do not erase persisted values`() {
        val persisted = AppConfig(
            dashboardUrl = dashboard,
            prometheusUrl = "http://prom:9090",
            refreshSeconds = 30,
            timeRange = "1h",
            displayMode = "amoled",
            dashboardName = "Name",
            capabilities = listOf("prometheus"),
        )
        val parsed = ConfigParser.parse(
            extras(
                "prometheus_url" to "",
                "refresh_seconds" to "",
                "time_range" to "",
                "display_mode" to "",
                "dashboard_name" to "",
                "capabilities" to "",
            ),
            persisted,
        )
        assertEquals(persisted, parsed.config)
    }

    @Test
    fun `missing or invalid required configuration fails with E_CONFIG`() {
        assertFails { ConfigParser.parse(emptyMap()) }
        assertFails { ConfigParser.parse(extras("dashboard_url" to "")) }
        assertFails {
            ConfigParser.parse(extras("dashboard_url" to "file:///tmp/dashboard.json"))
        }
        assertFails {
            ConfigParser.parse(extras("dashboard_url" to "http://user:pass@example.com/d.json"))
        }
        assertFails {
            ConfigParser.parse(extras("dashboard_url" to dashboard, "refresh_seconds" to "3601"))
        }
        assertFails {
            ConfigParser.parse(extras("dashboard_url" to dashboard, "refresh_seconds" to "1.5"))
        }
        assertFails {
            ConfigParser.parse(extras("dashboard_url" to dashboard, "time_range" to "500ms"))
        }
        assertFails {
            ConfigParser.parse(extras("dashboard_url" to dashboard, "time_range" to "31d"))
        }
        assertFails {
            ConfigParser.parse(extras("dashboard_url" to dashboard, "layout_mode" to "wide"))
        }
        assertFails {
            ConfigParser.parse(extras("dashboard_url" to dashboard, "display_mode" to "light"))
        }
        assertFails {
            ConfigParser.parse(extras("dashboard_url" to dashboard, "capabilities" to "bad id"))
        }
    }

    @Test
    fun `capabilities are normalized after deduplication`() {
        val parsed = ConfigParser.parse(
            extras(
                "dashboard_url" to dashboard,
                "capabilities" to "B,a,b, a",
            ),
        )
        assertEquals(listOf("a", "b"), parsed.config.capabilities)
    }

    @Test
    fun `too many distinct capabilities fail`() {
        val values = (0 until 17).joinToString(",") { "c$it" }
        assertFails {
            ConfigParser.parse(
                extras("dashboard_url" to dashboard, "capabilities" to values),
            )
        }
    }

    @Test
    fun `lock task is ignored outside kiosk mode`() {
        val parsed = ConfigParser.parse(
            extras(
                "dashboard_url" to dashboard,
                "kiosk" to "false",
                "lock_task" to "true",
            ),
        )
        assertFalse(parsed.lockTask)
    }

    @Test
    fun `show when locked follows kiosk mode`() {
        val enabled = ConfigParser.parse(
            extras(
                "dashboard_url" to dashboard,
                "kiosk" to "true",
                "show_when_locked" to "true",
            ),
        )
        assertTrue(enabled.showWhenLocked)
        assertFalse(enabled.lockTask)

        val ignored = ConfigParser.parse(
            extras(
                "dashboard_url" to dashboard,
                "kiosk" to "false",
                "show_when_locked" to "true",
            ),
        )
        assertFalse(ignored.showWhenLocked)
    }

    @Test
    fun `local URL encodes every parameter and round-trips`() {
        val url = "https://example.com/dashboard.json?tenant=a%20b&x=1"
        val config = AppConfig(
            dashboardUrl = url,
            prometheusUrl = "https://prom.example.com/base",
            refreshSeconds = 10,
            timeRange = "15m",
            stepSeconds = 15,
            debug = true,
            layoutMode = "grid",
            displayMode = "monochrome",
            dashboardName = "Main wall",
            capabilities = listOf("prometheus", "tempo"),
            showUnsupported = true,
        )
        val launch = ConfigParser.launchUrl(config)
        assertTrue(launch.startsWith("http://androdash.local/index.html?"))
        val query = launch.substringAfter("?")
        val parameters = query.split("&").associate { part ->
            val name = part.substringBefore("=")
            val value = URLDecoder.decode(part.substringAfter("="), "UTF-8")
            name to value
        }
        assertEquals(url, parameters["dashboard_url"])
        assertEquals("https://prom.example.com/base", parameters["prometheus_url"])
        assertEquals("10", parameters["refresh_seconds"])
        assertEquals("15m", parameters["time_range"])
        assertEquals("15", parameters["step_seconds"])
        assertEquals("true", parameters["debug"])
        assertEquals("grid", parameters["layout_mode"])
        assertEquals("monochrome", parameters["display_mode"])
        assertEquals("Main wall", parameters["dashboard_name"])
        assertEquals("prometheus,tempo", parameters["capabilities"])
        assertEquals("true", parameters["show_unsupported"])
    }

    @Test
    fun `unsupported duration syntax is rejected`() {
        assertFails {
            ConfigParser.parse(extras("dashboard_url" to dashboard, "time_range" to "1hour"))
        }
        assertFails {
            ConfigParser.parse(extras("dashboard_url" to dashboard, "time_range" to "1h-30m"))
        }
        assertFails {
            ConfigParser.parse(extras("dashboard_url" to dashboard, "time_range" to "999999999999999999999h"))
        }
    }

    @Test
    fun `null optional values remain unset`() {
        val parsed = ConfigParser.parse(
            extras(
                "dashboard_url" to dashboard,
                "prometheus_url" to null,
                "refresh_seconds" to null,
                "time_range" to null,
                "dashboard_name" to null,
                "capabilities" to null,
            ),
        )
        assertNull(parsed.config.prometheusUrl)
        assertNull(parsed.config.refreshSeconds)
        assertNull(parsed.config.timeRange)
        assertNull(parsed.config.dashboardName)
        assertNull(parsed.config.capabilities)
    }

    private fun assertFails(block: () -> Unit) {
        try {
            block()
            fail("Expected ConfigException")
        } catch (error: ConfigException) {
            assertEquals("E_CONFIG", error.code)
        }
    }
}
