package com.mbicz.androdash

import java.io.File
import java.nio.file.Files
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class DashboardStoreTest {
    private val filesDir: File = Files.createTempDirectory("androdash-store").toFile()
    private val source = "http://192.168.192.16:8099/contracts/fixtures/macos-node-dashboard.json"
    private val dashboard = """{"kind":"Dashboard","metadata":{"name":"mac"},"spec":{"panels":{}}}"""
    private var now = 1_761_600_000_000L
    private val store = DashboardStore(filesDir) { now }
    private val dir = File(filesDir, DashboardStore.DIR_NAME)

    @After
    fun cleanUp() {
        filesDir.deleteRecursively()
    }

    @Test
    fun `write stores the dashboard and its meta under fixed names`() {
        assertNull(store.readDashboard())
        assertNull(store.readMeta())

        val bytes = store.write(source, dashboard)

        assertEquals(dashboard.toByteArray(Charsets.UTF_8).size, bytes)
        assertArrayEquals(dashboard.toByteArray(Charsets.UTF_8), store.readDashboard())
        val meta = JSONObject(String(store.readMeta()!!, Charsets.UTF_8))
        assertEquals(source, meta.getString("sourceUrl"))
        assertEquals(now, meta.getLong("storedAt"))
        assertEquals(bytes, meta.getInt("bytes"))
        assertEquals(setOf("sourceUrl", "storedAt", "bytes"), meta.keys().asSequence().toSet())
        assertEquals(
            setOf(DashboardStore.DASHBOARD_FILE, DashboardStore.META_FILE),
            dir.list()!!.toSet(),
        )
    }

    @Test
    fun `meta counts UTF-8 bytes, not chars`() {
        val json = """{"title":"Mac — température"}"""
        val bytes = store.write(source, json)
        assertEquals(json.toByteArray(Charsets.UTF_8).size, bytes)
        assertTrue(bytes > json.length)
        assertEquals(bytes, JSONObject(String(store.readMeta()!!, Charsets.UTF_8)).getInt("bytes"))
    }

    @Test
    fun `size limit is 5 MiB of UTF-8`() {
        val prefix = """{"pad":""""
        val suffix = """"}"""
        val fill = DashboardStore.MAX_BYTES - prefix.length - suffix.length
        val atLimit = prefix + "a".repeat(fill) + suffix
        assertEquals(DashboardStore.MAX_BYTES, store.write(source, atLimit))

        assertRejected(prefix + "a".repeat(fill + 1) + suffix)
        // Under the limit in chars, over it in bytes: "é" is two UTF-8 bytes.
        assertRejected(prefix + "é".repeat(fill / 2 + 1) + suffix)
        // The rejected writes left the earlier copy intact.
        assertEquals(DashboardStore.MAX_BYTES, store.readDashboard()!!.size)
    }

    @Test
    fun `non-object JSON is rejected`() {
        listOf(
            "",
            "   ",
            "[]",
            "[{\"kind\":\"Dashboard\"}]",
            "\"dashboard\"",
            "42",
            "null",
            "not json",
            "{\"kind\":",
            "{} trailing",
            "{}{}",
        ).forEach { assertRejected(it) }
        assertNull(store.readDashboard())
        assertNull(store.readMeta())
        assertFalse(dir.exists() && dir.list()!!.isNotEmpty())
    }

    @Test
    fun `empty source URL is rejected`() {
        try {
            store.write("", dashboard)
            fail("Expected IllegalArgumentException")
        } catch (_: IllegalArgumentException) {
            // expected
        }
        assertNull(store.readMeta())
    }

    @Test
    fun `overwrite replaces dashboard and meta together`() {
        store.write(source, dashboard)
        now += 60_000
        val other = "http://192.168.192.16:8099/contracts/fixtures/spark-dashboard.json"
        val replacement = """{"kind":"Dashboard","metadata":{"name":"spark"}}"""
        store.write(other, replacement)

        assertArrayEquals(replacement.toByteArray(Charsets.UTF_8), store.readDashboard())
        val meta = JSONObject(String(store.readMeta()!!, Charsets.UTF_8))
        assertEquals(other, meta.getString("sourceUrl"))
        assertEquals(now, meta.getLong("storedAt"))
        assertEquals(replacement.length, meta.getInt("bytes"))
        assertEquals(2, dir.list()!!.size)
    }

    @Test
    fun `clear removes the stored copy`() {
        store.write(source, dashboard)
        store.clear()
        assertNull(store.readDashboard())
        assertNull(store.readMeta())
        assertEquals(0, dir.list()!!.size)
        store.clear()
        DashboardStore(File(filesDir, "never-created")).clear()
    }

    @Test
    fun `a dashboard without its meta reads as nothing stored`() {
        // An interrupted write: the meta is removed first and renamed in last.
        store.write(source, dashboard)
        File(dir, DashboardStore.META_FILE).delete()
        assertNull(store.readDashboard())
        assertNull(store.readMeta())

        // A meta without its dashboard is equally absent.
        store.write(source, dashboard)
        File(dir, DashboardStore.DASHBOARD_FILE).delete()
        assertNull(store.readDashboard())
        assertNull(store.readMeta())

        // Stale temp files from a crash do not block the next write.
        File(dir, "${DashboardStore.DASHBOARD_FILE}.tmp").writeText("partial")
        File(dir, "${DashboardStore.META_FILE}.tmp").writeText("partial")
        store.write(source, dashboard)
        assertArrayEquals(dashboard.toByteArray(Charsets.UTF_8), store.readDashboard())
        assertEquals(
            setOf(DashboardStore.DASHBOARD_FILE, DashboardStore.META_FILE),
            dir.list()!!.toSet(),
        )
    }

    @Test
    fun `storeDashboard only accepts the current stored-mode remote dashboard`() {
        val config = AppConfig(dashboardUrl = source)
        assertTrue(DashboardStore.acceptsSource(config, source))

        assertFalse(DashboardStore.acceptsSource(config, null))
        assertFalse(DashboardStore.acceptsSource(config, ""))
        assertFalse(DashboardStore.acceptsSource(config, "$source?x=1"))
        assertFalse(DashboardStore.acceptsSource(config, "http://evil.example/d.json"))
        assertFalse(DashboardStore.acceptsSource(config.copy(dashboardSource = "url"), source))

        val bundled = "http://androdash.local/dashboards/macos-node-dashboard.json"
        assertFalse(DashboardStore.acceptsSource(AppConfig(dashboardUrl = bundled), bundled))
        val upper = "http://ANDRODASH.local/dashboards/macos-node-dashboard.json"
        assertFalse(DashboardStore.acceptsSource(AppConfig(dashboardUrl = upper), upper))
    }

    private fun assertRejected(json: String) {
        try {
            store.write(source, json)
            fail("Expected IllegalArgumentException for ${json.take(40)}")
        } catch (_: IllegalArgumentException) {
            // expected
        }
    }
}
