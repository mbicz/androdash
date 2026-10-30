package com.mbicz.androdash

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class IgnitionTest {
    private val dashboard = "http://192.168.1.20:8099/demo-dashboard.json"
    private val other = "http://192.168.1.20:8099/macos-node-dashboard.json"
    private val bundled = "http://androdash.local/dashboards/phone-dashboard.json"
    private val inlineUrl = InlineDashboards.url("0123456789abcdef")

    private val base = AppConfig(
        dashboardUrl = dashboard,
        dashboardUrls = listOf(dashboard, other),
        prometheusUrl = "http://192.168.1.20:9090",
        refreshSeconds = 30,
        timeRange = "1h",
        layoutMode = "grid",
        displayMode = "standard",
        lockStyle = "color",
        kiosk = true,
        debug = false,
        collector = false,
        collectorTargets = "old.lan:9100",
        collectorScrapeSeconds = 30,
        collectorRetention = "12h",
        collectorPhone = true,
        rotateSeconds = 60,
    )

    @Test
    fun `an empty document keeps every persisted value`() {
        val merged = Ignition.merge(base, Ignition.parse("{}"))
        assertEquals(base, merged)
    }

    @Test
    fun `a full document replaces the persisted values`() {
        val merged = Ignition.merge(base, Ignition.parse(FULL))
        assertEquals(
            AppConfig(
                dashboardUrl = other,
                dashboardUrls = listOf(dashboard, other),
                prometheusUrl = "http://192.168.1.20:9091",
                refreshSeconds = 10,
                timeRange = "15m",
                layoutMode = "fit",
                displayMode = "amoled",
                lockStyle = "monochrome",
                kiosk = false,
                debug = true,
                collector = true,
                collectorTargets = "node:mac=192.168.1.20:9100",
                collectorScrapeSeconds = 15,
                collectorRetention = "24h",
                collectorPhone = true,
                rotateSeconds = 0,
            ),
            merged,
        )
        ConfigParser.validateConfig(merged)
    }

    @Test
    fun `dashboards urls replace the list and current selects the shown one`() {
        val merged = Ignition.merge(
            base,
            Ignition.parse("""{"dashboards":{"urls":["$bundled","$dashboard"],"current":"$dashboard"}}"""),
        )
        assertEquals(listOf(bundled, dashboard), merged.dashboardUrls)
        assertEquals(dashboard, merged.dashboardUrl)

        val first = Ignition.merge(
            base,
            Ignition.parse("""{"dashboards":{"urls":["$bundled","$dashboard"]}}"""),
        )
        assertEquals(bundled, first.dashboardUrl)
        assertEquals(listOf(bundled, dashboard), first.dashboardUrls)

        // Without urls the persisted list stays; current may pick another entry.
        val switched = Ignition.merge(base, Ignition.parse("""{"dashboards":{"current":"$other"}}"""))
        assertEquals(base.dashboardUrls, switched.dashboardUrls)
        assertEquals(other, switched.dashboardUrl)
    }

    @Test
    fun `current outside the dashboard list is rejected`() {
        assertRejected { Ignition.merge(base, Ignition.parse("""{"dashboards":{"urls":["$bundled"],"current":"$other"}}""")) }
        assertRejected { Ignition.merge(base, Ignition.parse("""{"dashboards":{"current":"$bundled"}}""")) }
    }

    @Test
    fun `inline dashboards follow the urls and current may name one`() {
        val document = Ignition.parse(
            """{"dashboards":{"urls":["$bundled"],"current":"$inlineUrl","inline":[{"spec":{}}]}}""",
        )
        assertEquals(1, document.inlineDashboards.size)

        val merged = Ignition.merge(base, document.withInlineUrls(listOf(inlineUrl)))
        assertEquals(listOf(bundled, inlineUrl), merged.dashboardUrls)
        assertEquals(inlineUrl, merged.dashboardUrl)

        // Without urls the persisted list comes first, then the inline URLs.
        val appended = Ignition.merge(base, Ignition.parse("{}").withInlineUrls(listOf(inlineUrl)))
        assertEquals(base.dashboardUrls + inlineUrl, appended.dashboardUrls)
        assertEquals(dashboard, appended.dashboardUrl)
    }

    @Test
    fun `inline dashboards beyond the dashboard limit are rejected`() {
        val urls = (1..7).map { InlineDashboards.url("000000000000000$it") }
        assertRejected { Ignition.merge(base, Ignition.parse("{}").withInlineUrls(urls)) }
        // Exactly eight in total is fine.
        val merged = Ignition.merge(base, Ignition.parse("{}").withInlineUrls(urls.take(6)))
        assertEquals(base.dashboardUrls + urls.take(6), merged.dashboardUrls)
    }

    @Test
    fun `collector fields merge and the empty targets string clears them`() {
        val merged = Ignition.merge(
            base,
            Ignition.parse(
                """{"collector":{"enabled":true,"targets":"mac=192.168.1.20:9100","phone":false,"scrapeSeconds":5,"retention":"7d"}}""",
            ),
        )
        assertTrue(merged.collector)
        assertEquals("node:mac=192.168.1.20:9100", merged.collectorTargets)
        assertFalse(merged.collectorPhone)
        assertEquals(5, merged.collectorScrapeSeconds)
        assertEquals("7d", merged.collectorRetention)

        val cleared = Ignition.merge(
            base.copy(collector = true),
            Ignition.parse("""{"collector":{"targets":""}}"""),
        )
        assertNull(cleared.collectorTargets)
        assertTrue(cleared.collector)
    }

    @Test
    fun `collector enabled without targets or the phone exporter is rejected`() {
        val noTargets = base.copy(collectorTargets = null)
        assertRejected { Ignition.merge(noTargets, Ignition.parse("""{"collector":{"enabled":true,"targets":"","phone":false}}""")) }
        assertRejected { Ignition.merge(noTargets, Ignition.parse("""{"collector":{"enabled":true,"phone":false}}""")) }
        // Clearing the targets while the collector is on and the phone exporter is off fails.
        assertRejected {
            Ignition.merge(
                base.copy(collector = true),
                Ignition.parse("""{"collector":{"targets":"","phone":false}}"""),
            )
        }
    }

    @Test
    fun `unknown keys, wrong types and the wrong schema version are rejected`() {
        assertRejected("""{"dashboardsx":{}}""")
        assertRejected("""{"dashboards":{"url":["$bundled"]}}""")
        assertRejected("""{"collector":{"target":"a.lan:9100"}}""")
        assertRejected("""{"schemaVersion":2}""")
        assertRejected("""{"schemaVersion":"1"}""")
        assertRejected("""{"kiosk":"true"}""")
        assertRejected("""{"refreshSeconds":10.5}""")
        assertRejected("""{"dashboards":{"urls":"$bundled"}}""")
        assertRejected("""{"dashboards":{"inline":[1]}}""")
        assertRejected("""{"collector":{"enabled":"yes"}}""")
        assertRejected("""{"timeRange":900}""")
        assertRejected("[]")
        assertRejected("""{} {}""")
        assertRejected("not json")
    }

    @Test
    fun `invalid URLs and out-of-range values are rejected`() {
        assertRejected("""{"dashboards":{"urls":["ftp://example.com/d.json"]}}""")
        assertRejected("""{"dashboards":{"urls":["http://user:pw@example.com/d.json"]}}""")
        assertRejected("""{"dashboards":{"urls":["http://"]}}""")
        assertRejected("""{"dashboards":{"current":"nope"}}""")
        assertRejected("""{"prometheusUrl":"file:///etc/passwd"}""")
        assertRejected("""{"layoutMode":"mosaic"}""")
        assertRejected("""{"displayMode":"bright"}""")
        assertRejected("""{"lockStyle":"sepia"}""")
        assertRejected("""{"timeRange":"31d"}""")
        assertRejected("""{"refreshSeconds":-1}""")
        assertRejected("""{"rotateSeconds":5}""")
        assertRejected("""{"collector":{"scrapeSeconds":4}}""")
        assertRejected("""{"collector":{"scrapeSeconds":301}}""")
        assertRejected("""{"collector":{"retention":"30m"}}""")
        assertRejected("""{"collector":{"retention":"31d"}}""")
        assertRejected("""{"collector":{"targets":"a.lan"}}""")
    }

    @Test
    fun `the dashboard list and the inline list hold at most eight entries`() {
        val eight = (1..8).map { "http://androdash.local/dashboards/d$it.json" }
        val nine = (1..9).map { "http://androdash.local/dashboards/d$it.json" }
        assertEquals(
            eight,
            Ignition.merge(base, Ignition.parse("""{"dashboards":{"urls":[${eight.joinToString(",") { "\"$it\"" }}]}}"""))
                .dashboardUrls,
        )
        assertRejected("""{"dashboards":{"urls":[${nine.joinToString(",") { "\"$it\"" }}]}}""")
        assertRejected("""{"dashboards":{"urls":[]}}""")
        val inline = (1..9).joinToString(",") { """{"n":$it}""" }
        assertRejected("""{"dashboards":{"inline":[$inline]}}""")
    }

    @Test
    fun `a document over the byte limit is rejected`() {
        assertRejected("{${" ".repeat(Ignition.MAX_BYTES)}}")
        assertRejected("""{"dashboards":{"inline":[{"a":"${"x".repeat(Ignition.MAX_BYTES)}"}]}}""")
    }

    @Test
    fun `a document without dashboards seeds a device with nothing persisted`() {
        assertRejected { Ignition.merge(null, Ignition.parse("""{"kiosk":true}""")) }
        val seeded = Ignition.merge(null, Ignition.parse("""{"dashboards":{"urls":["$bundled"]}}"""))
        assertEquals(bundled, seeded.dashboardUrl)
        assertEquals(listOf(bundled), seeded.dashboardUrls)
        assertTrue(seeded.kiosk)
        assertFalse(seeded.collector)
    }

    private fun assertRejected(text: String) {
        assertRejected { Ignition.merge(base, Ignition.parse(text)) }
    }

    private fun assertRejected(block: () -> Unit) {
        try {
            block()
            fail("Expected ConfigException")
        } catch (error: ConfigException) {
            assertEquals(Ignition.CODE_INVALID, error.code)
        }
    }

    private val FULL = """
        {
          "schemaVersion": 1,
          "dashboards": {
            "urls": ["$dashboard", "$other"],
            "current": "$other"
          },
          "collector": {
            "enabled": true,
            "targets": "node:mac=192.168.1.20:9100",
            "phone": true,
            "scrapeSeconds": 15,
            "retention": "24h"
          },
          "prometheusUrl": "http://192.168.1.20:9091",
          "layoutMode": "fit",
          "displayMode": "amoled",
          "lockStyle": "monochrome",
          "refreshSeconds": 10,
          "timeRange": "15m",
          "rotateSeconds": 0,
          "kiosk": false,
          "debug": true
        }
    """
}
