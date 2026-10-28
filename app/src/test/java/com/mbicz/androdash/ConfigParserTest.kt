package com.mbicz.androdash

import java.net.URLDecoder
import org.json.JSONObject
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
            lockStyle = "color",
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
            lockStyle = "color",
            dashboardSource = "url",
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
        assertEquals("color", parameters["lock_style"])
        assertEquals("url", parameters["dashboard_source"])
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

    @Test
    fun `show when locked falls back to the persisted preference`() {
        val restored = ConfigParser.parse(extras(), AppConfig(dashboardUrl = dashboard), persistedShowWhenLocked = true)
        assertTrue(restored.showWhenLocked)
        assertTrue(restored.showWhenLockedPreference)

        val overridden = ConfigParser.parse(
            extras("show_when_locked" to "false"),
            AppConfig(dashboardUrl = dashboard),
            persistedShowWhenLocked = true,
        )
        assertFalse(overridden.showWhenLocked)
        assertFalse(overridden.showWhenLockedPreference)

        val dev = ConfigParser.parse(
            extras("kiosk" to "false"),
            AppConfig(dashboardUrl = dashboard),
            persistedShowWhenLocked = true,
        )
        assertFalse(dev.showWhenLocked)
        assertTrue(dev.showWhenLockedPreference)

        assertFalse(ConfigParser.parse(extras("dashboard_url" to dashboard)).showWhenLockedPreference)
    }

    @Test
    fun `layout_mode fit is accepted and round-trips`() {
        val parsed = ConfigParser.parse(extras("dashboard_url" to dashboard, "layout_mode" to " FIT "))
        assertEquals("fit", parsed.config.layoutMode)
        assertTrue(ConfigParser.launchUrl(parsed.config).contains("&layout_mode=fit&"))
    }

    @Test
    fun `lock_style defaults to monochrome and accepts color`() {
        val defaulted = ConfigParser.parse(extras("dashboard_url" to dashboard))
        assertEquals("monochrome", defaulted.config.lockStyle)
        assertTrue(ConfigParser.launchUrl(defaulted.config).contains("&lock_style=monochrome&"))

        val explicit = ConfigParser.parse(extras("dashboard_url" to dashboard, "lock_style" to "Color"))
        assertEquals("color", explicit.config.lockStyle)
        assertTrue(ConfigParser.launchUrl(explicit.config).contains("&lock_style=color&"))

        val kept = ConfigParser.parse(
            extras("lock_style" to ""),
            AppConfig(dashboardUrl = dashboard, lockStyle = "color"),
        )
        assertEquals("color", kept.config.lockStyle)

        assertFails { ConfigParser.parse(extras("dashboard_url" to dashboard, "lock_style" to "colour")) }
        assertFails { ConfigParser.validateConfig(AppConfig(dashboardUrl = dashboard, lockStyle = "sepia")) }
    }

    @Test
    fun `persisted config round-trips lock_style and defaults it when missing`() {
        val config = AppConfig(dashboardUrl = dashboard, layoutMode = "fit", lockStyle = "color")
        assertEquals(config, ConfigParser.decodePersisted(config.toJson()))

        val legacy = JSONObject(AppConfig(dashboardUrl = dashboard).toJson()).apply {
            remove("lockStyle")
        }.toString()
        val decoded = ConfigParser.decodePersisted(legacy)
        assertEquals("monochrome", decoded?.lockStyle)
        assertEquals(1, JSONObject(legacy).getInt("schemaVersion"))

        val invalid = JSONObject(config.toJson()).put("lockStyle", "sepia").toString()
        assertNull(ConfigParser.decodePersisted(invalid))
    }

    @Test
    fun `setOption applies each validated option`() {
        val base = AppConfig(dashboardUrl = dashboard, refreshSeconds = 30, timeRange = "1h")

        val range = ConfigParser.applyOption(base, "time_range", " 7d ")
        assertEquals("7d", range.config.timeRange)
        assertEquals(30, range.config.refreshSeconds)

        val manual = ConfigParser.applyOption(base, "refresh_seconds", "0")
        assertEquals(0, manual.config.refreshSeconds)
        assertEquals("1h", manual.config.timeRange)

        val refresh = ConfigParser.applyOption(base, "refresh_seconds", "3600")
        assertEquals(3600, refresh.config.refreshSeconds)
        assertTrue(ConfigParser.launchUrl(refresh.config).contains("refresh_seconds=3600"))

        val clamped = ConfigParser.applyOption(base, "refresh_seconds", "3")
        assertEquals(5, clamped.config.refreshSeconds)
        assertTrue(clamped.warnings.single().startsWith("W_REFRESH_CLAMPED"))

        val layout = ConfigParser.applyOption(base, "layout_mode", "Fit")
        assertEquals("fit", layout.config.layoutMode)
        assertEquals(base.copy(layoutMode = "fit"), layout.config)
        assertTrue(ConfigParser.launchUrl(layout.config).contains("layout_mode=fit"))

        val lock = ConfigParser.applyOption(base, "lock_style", "color")
        assertEquals(base.copy(lockStyle = "color"), lock.config)
        assertTrue(ConfigParser.launchUrl(lock.config).contains("lock_style=color"))
        assertTrue(lock.warnings.isEmpty())
    }

    @Test
    fun `setOption rejects invalid values and unknown names`() {
        val base = AppConfig(dashboardUrl = dashboard)
        assertFails { ConfigParser.applyOption(base, "time_range", "31d") }
        assertFails { ConfigParser.applyOption(base, "time_range", "15 minutes") }
        assertFails { ConfigParser.applyOption(base, "time_range", "1h".repeat(33)) }
        assertFails { ConfigParser.applyOption(base, "time_range", " ") }
        assertFails { ConfigParser.applyOption(base, "time_range", null) }
        assertFails { ConfigParser.applyOption(base, "refresh_seconds", "3601") }
        assertFails { ConfigParser.applyOption(base, "refresh_seconds", "-1") }
        assertFails { ConfigParser.applyOption(base, "refresh_seconds", "fast") }
        assertFails { ConfigParser.applyOption(base, "layout_mode", "wide") }
        assertFails { ConfigParser.applyOption(base, "lock_style", "sepia") }
        assertFails { ConfigParser.applyOption(base, "display_mode", "amoled") }
        assertFails { ConfigParser.applyOption(base, "dashboard_url", "https://example.com/d.json") }
        assertFails { ConfigParser.applyOption(base, "x".repeat(65), "1h") }
        assertFails { ConfigParser.applyOption(base, null, "1h") }
    }

    @Test
    fun `dashboard_source defaults to stored and accepts url`() {
        val defaulted = ConfigParser.parse(extras("dashboard_url" to dashboard))
        assertEquals("stored", defaulted.config.dashboardSource)
        assertTrue(
            ConfigParser.launchUrl(defaulted.config)
                .contains("&lock_style=monochrome&dashboard_source=stored&"),
        )

        val explicit = ConfigParser.parse(extras("dashboard_url" to dashboard, "dashboard_source" to " URL "))
        assertEquals("url", explicit.config.dashboardSource)
        assertTrue(ConfigParser.launchUrl(explicit.config).contains("&dashboard_source=url&"))

        val kept = ConfigParser.parse(
            extras("dashboard_source" to ""),
            AppConfig(dashboardUrl = dashboard, dashboardSource = "url"),
        )
        assertEquals("url", kept.config.dashboardSource)

        val overridden = ConfigParser.parse(
            extras("dashboard_source" to "stored"),
            AppConfig(dashboardUrl = dashboard, dashboardSource = "url"),
        )
        assertEquals("stored", overridden.config.dashboardSource)
    }

    @Test
    fun `invalid dashboard_source is rejected`() {
        assertFails { ConfigParser.parse(extras("dashboard_url" to dashboard, "dashboard_source" to "cache")) }
        assertFails { ConfigParser.parse(extras("dashboard_url" to dashboard, "dashboard_source" to "bundled")) }
        assertFails {
            ConfigParser.validateConfig(AppConfig(dashboardUrl = dashboard, dashboardSource = "local"))
        }
    }

    @Test
    fun `persisted config round-trips dashboard_source and defaults it when missing`() {
        val config = AppConfig(dashboardUrl = dashboard, dashboardSource = "url")
        assertEquals(config, ConfigParser.decodePersisted(config.toJson()))
        assertEquals("url", JSONObject(config.toJson()).getString("dashboardSource"))

        val legacy = JSONObject(AppConfig(dashboardUrl = dashboard).toJson()).apply {
            remove("dashboardSource")
        }.toString()
        val decoded = ConfigParser.decodePersisted(legacy)
        assertEquals("stored", decoded?.dashboardSource)
        assertEquals(1, JSONObject(legacy).getInt("schemaVersion"))

        val invalid = JSONObject(config.toJson()).put("dashboardSource", "cache").toString()
        assertNull(ConfigParser.decodePersisted(invalid))
    }

    @Test
    fun `setOption dashboard_source uses the launch enum`() {
        val base = AppConfig(dashboardUrl = dashboard, timeRange = "1h")
        val url = ConfigParser.applyOption(base, "dashboard_source", " Url ")
        assertEquals(base.copy(dashboardSource = "url"), url.config)
        assertTrue(ConfigParser.launchUrl(url.config).contains("dashboard_source=url"))
        assertTrue(url.warnings.isEmpty())

        val stored = ConfigParser.applyOption(url.config, "dashboard_source", "stored")
        assertEquals(base, stored.config)

        assertFails { ConfigParser.applyOption(base, "dashboard_source", "cache") }
        assertFails { ConfigParser.applyOption(base, "dashboard_source", " ") }
        assertFails { ConfigParser.applyOption(base, "dashboard_source", null) }
    }

    @Test
    fun `bundled dashboard URLs on the virtual origin are valid`() {
        val bundled = "http://androdash.local/dashboards/macos-node-dashboard.json"
        val parsed = ConfigParser.parse(extras("dashboard_url" to bundled))
        assertEquals(bundled, parsed.config.dashboardUrl)
        assertEquals("stored", parsed.config.dashboardSource)
        val query = ConfigParser.launchUrl(parsed.config).substringAfter("?")
        assertTrue(
            query.startsWith(
                "dashboard_url=http%3A%2F%2Fandrodash.local%2Fdashboards%2Fmacos-node-dashboard.json&",
            ),
        )
        assertEquals(parsed.config, ConfigParser.decodePersisted(parsed.config.toJson()))
    }

    @Test
    fun `collector defaults are off, 15 s, 24h`() {
        val config = ConfigParser.parse(extras("dashboard_url" to dashboard)).config
        assertFalse(config.collector)
        assertNull(config.collectorTargets)
        assertEquals(15, config.collectorScrapeSeconds)
        assertEquals("24h", config.collectorRetention)
    }

    @Test
    fun `collector extras parse, persist, and stay out of the query except prometheus_url`() {
        val parsed = ConfigParser.parse(
            extras(
                "dashboard_url" to dashboard,
                "prometheus_url" to "http://192.168.192.16:9090",
                "collector" to "true",
                "collector_targets" to " node:mac=192.168.192.16:9100 , 10.0.0.5:9100 ",
                "collector_scrape_seconds" to "10",
                "collector_retention" to "6h",
            ),
        )
        val config = parsed.config
        assertTrue(config.collector)
        assertEquals("node:mac=192.168.192.16:9100,10.0.0.5:9100", config.collectorTargets)
        assertEquals(10, config.collectorScrapeSeconds)
        assertEquals("6h", config.collectorRetention)
        assertEquals("http://192.168.192.16:9090", config.prometheusUrl)

        val query = ConfigParser.launchUrl(config).substringAfter("?")
        val parameters = query.split("&").associate { part ->
            val (name, value) = part.split("=", limit = 2)
            name to URLDecoder.decode(value, "UTF-8")
        }
        assertEquals("http://127.0.0.1:19090", parameters["prometheus_url"])
        assertFalse(parameters.keys.any { it.startsWith("collector") })

        val json = JSONObject(config.toJson())
        assertTrue(json.getBoolean("collector"))
        assertEquals("node:mac=192.168.192.16:9100,10.0.0.5:9100", json.getString("collectorTargets"))
        assertEquals(10, json.getInt("collectorScrapeSeconds"))
        assertEquals("6h", json.getString("collectorRetention"))
        assertEquals(config, ConfigParser.decodePersisted(config.toJson()))
    }

    @Test
    fun `collector off restores the configured prometheus_url and keeps the targets`() {
        val on = ConfigParser.parse(
            extras(
                "dashboard_url" to dashboard,
                "prometheus_url" to "http://192.168.192.16:9090",
                "collector" to "true",
                "collector_targets" to "a.lan:9100",
            ),
        ).config
        val off = ConfigParser.parse(extras("collector" to "false"), on).config
        assertFalse(off.collector)
        assertEquals("a.lan:9100", off.collectorTargets)
        assertTrue(ConfigParser.launchUrl(off).contains("prometheus_url=http%3A%2F%2F192.168.192.16%3A9090"))

        val again = ConfigParser.parse(extras("collector" to "true", "collector_targets" to ""), off).config
        assertTrue(again.collector)
        assertEquals("a.lan:9100", again.collectorTargets)
    }

    @Test
    fun `collector without targets is E_CONFIG`() {
        assertFails { ConfigParser.parse(extras("dashboard_url" to dashboard, "collector" to "true")) }
        assertFails {
            ConfigParser.parse(extras("dashboard_url" to dashboard, "collector" to "true", "collector_targets" to " "))
        }
        assertFails {
            ConfigParser.parse(extras("dashboard_url" to dashboard, "collector" to "true", "collector_targets" to ",,"))
        }
    }

    @Test
    fun `collector field limits are E_CONFIG`() {
        fun launch(vararg values: Pair<String, String?>) =
            ConfigParser.parse(extras("dashboard_url" to dashboard, *values))
        assertEquals(5, launch("collector_scrape_seconds" to "5").config.collectorScrapeSeconds)
        assertEquals(300, launch("collector_scrape_seconds" to "300").config.collectorScrapeSeconds)
        assertEquals("1h", launch("collector_retention" to "1h").config.collectorRetention)
        assertEquals("30d", launch("collector_retention" to "30d").config.collectorRetention)
        assertEquals("1h30m", launch("collector_retention" to "1h30m").config.collectorRetention)
        assertFails { launch("collector_scrape_seconds" to "4") }
        assertFails { launch("collector_scrape_seconds" to "301") }
        assertFails { launch("collector_scrape_seconds" to "15s") }
        assertFails { launch("collector_retention" to "59m") }
        assertFails { launch("collector_retention" to "31d") }
        assertFails { launch("collector_retention" to "24") }
        assertFails { launch("collector" to "yes") }
        assertFails { launch("collector_targets" to "host") }
        assertFails { launch("collector_targets" to (1..33).joinToString(",") { "h$it:9100" }) }
    }

    @Test
    fun `persisted collector fields are validated and default when absent`() {
        val config = AppConfig(
            dashboardUrl = dashboard,
            collector = true,
            collectorTargets = "a.lan:9100",
        )
        val legacy = JSONObject(AppConfig(dashboardUrl = dashboard).toJson()).apply {
            remove("collector")
            remove("collectorTargets")
            remove("collectorScrapeSeconds")
            remove("collectorRetention")
        }.toString()
        assertEquals(AppConfig(dashboardUrl = dashboard), ConfigParser.decodePersisted(legacy))
        listOf(
            "collectorTargets" to "bad",
            "collectorScrapeSeconds" to 1,
            "collectorRetention" to "10m",
        ).forEach { (key, value) ->
            assertNull(ConfigParser.decodePersisted(JSONObject(config.toJson()).put(key, value).toString()))
        }
        assertNull(
            ConfigParser.decodePersisted(JSONObject(config.toJson()).put("collectorTargets", JSONObject.NULL).toString()),
        )
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
