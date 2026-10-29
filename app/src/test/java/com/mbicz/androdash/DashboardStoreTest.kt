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
    fun `write stores the dashboard and its meta under the slot's fixed names`() {
        assertNull(store.readDashboard(0))
        assertNull(store.readMeta(0))

        val bytes = store.write(0, source, dashboard)

        assertEquals(dashboard.toByteArray(Charsets.UTF_8).size, bytes)
        assertArrayEquals(dashboard.toByteArray(Charsets.UTF_8), store.readDashboard(0))
        val meta = JSONObject(String(store.readMeta(0)!!, Charsets.UTF_8))
        assertEquals(source, meta.getString("sourceUrl"))
        assertEquals(now, meta.getLong("storedAt"))
        assertEquals(bytes, meta.getInt("bytes"))
        assertEquals(setOf("sourceUrl", "storedAt", "bytes"), meta.keys().asSequence().toSet())
        assertEquals(setOf("stored-0.json", "stored-0.meta.json"), dir.list()!!.toSet())
    }

    @Test
    fun `slots are independent`() {
        val other = "http://192.168.192.16:8099/contracts/fixtures/spark-dashboard.json"
        val spark = """{"kind":"Dashboard","metadata":{"name":"spark"}}"""
        store.write(0, source, dashboard)
        store.write(7, other, spark)

        assertArrayEquals(dashboard.toByteArray(Charsets.UTF_8), store.readDashboard(0))
        assertArrayEquals(spark.toByteArray(Charsets.UTF_8), store.readDashboard(7))
        assertEquals(other, JSONObject(String(store.readMeta(7)!!, Charsets.UTF_8)).getString("sourceUrl"))
        for (slot in 1..6) {
            assertNull(store.readDashboard(slot))
            assertNull(store.readMeta(slot))
        }
        assertEquals(
            setOf("stored-0.json", "stored-0.meta.json", "stored-7.json", "stored-7.meta.json"),
            dir.list()!!.toSet(),
        )
    }

    @Test
    fun `slots outside 0 to 7 are rejected and read as absent`() {
        assertEquals(8, DashboardStore.SLOTS)
        listOf(-1, 8, Int.MAX_VALUE).forEach { slot ->
            try {
                store.write(slot, source, dashboard)
                fail("Expected IllegalArgumentException for slot $slot")
            } catch (_: IllegalArgumentException) {
                // expected
            }
            assertNull(store.readDashboard(slot))
            assertNull(store.readMeta(slot))
        }
        assertFalse(dir.exists() && dir.list()!!.isNotEmpty())
    }

    @Test
    fun `meta counts UTF-8 bytes, not chars`() {
        val json = """{"title":"Mac — température"}"""
        val bytes = store.write(0, source, json)
        assertEquals(json.toByteArray(Charsets.UTF_8).size, bytes)
        assertTrue(bytes > json.length)
        assertEquals(bytes, JSONObject(String(store.readMeta(0)!!, Charsets.UTF_8)).getInt("bytes"))
    }

    @Test
    fun `size limit is 5 MiB of UTF-8`() {
        val prefix = """{"pad":""""
        val suffix = """"}"""
        val fill = DashboardStore.MAX_BYTES - prefix.length - suffix.length
        val atLimit = prefix + "a".repeat(fill) + suffix
        assertEquals(DashboardStore.MAX_BYTES, store.write(0, source, atLimit))

        assertRejected(prefix + "a".repeat(fill + 1) + suffix)
        // Under the limit in chars, over it in bytes: "é" is two UTF-8 bytes.
        assertRejected(prefix + "é".repeat(fill / 2 + 1) + suffix)
        // The rejected writes left the earlier copy intact.
        assertEquals(DashboardStore.MAX_BYTES, store.readDashboard(0)!!.size)
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
        assertNull(store.readDashboard(0))
        assertNull(store.readMeta(0))
        assertFalse(dir.exists() && dir.list()!!.isNotEmpty())
    }

    @Test
    fun `empty source URL is rejected`() {
        try {
            store.write(0, "", dashboard)
            fail("Expected IllegalArgumentException")
        } catch (_: IllegalArgumentException) {
            // expected
        }
        assertNull(store.readMeta(0))
    }

    @Test
    fun `overwrite replaces dashboard and meta together`() {
        store.write(1, source, dashboard)
        now += 60_000
        val other = "http://192.168.192.16:8099/contracts/fixtures/spark-dashboard.json"
        val replacement = """{"kind":"Dashboard","metadata":{"name":"spark"}}"""
        store.write(1, other, replacement)

        assertArrayEquals(replacement.toByteArray(Charsets.UTF_8), store.readDashboard(1))
        val meta = JSONObject(String(store.readMeta(1)!!, Charsets.UTF_8))
        assertEquals(other, meta.getString("sourceUrl"))
        assertEquals(now, meta.getLong("storedAt"))
        assertEquals(replacement.length, meta.getInt("bytes"))
        assertEquals(2, dir.list()!!.size)
    }

    @Test
    fun `clear removes every slot`() {
        store.write(0, source, dashboard)
        store.write(5, source, dashboard)
        File(dir, "stored-3.json.tmp").writeText("partial")
        store.clear()
        for (slot in 0 until DashboardStore.SLOTS) {
            assertNull(store.readDashboard(slot))
            assertNull(store.readMeta(slot))
        }
        assertEquals(0, dir.list()!!.size)
        store.clear()
        DashboardStore(File(filesDir, "never-created")).clear()
    }

    @Test
    fun `removeLegacy deletes the pre-slot single copy only`() {
        dir.mkdirs()
        listOf("stored.json", "stored.meta.json", "stored.json.tmp", "stored.meta.json.tmp")
            .forEach { File(dir, it).writeText("{}") }
        store.write(0, source, dashboard)

        store.removeLegacy()

        assertEquals(setOf("stored-0.json", "stored-0.meta.json"), dir.list()!!.toSet())
        assertArrayEquals(dashboard.toByteArray(Charsets.UTF_8), store.readDashboard(0))
        store.removeLegacy()
        DashboardStore(File(filesDir, "never-created")).removeLegacy()
    }

    @Test
    fun `a dashboard without its meta reads as nothing stored`() {
        // An interrupted write: the meta is removed first and renamed in last.
        store.write(2, source, dashboard)
        File(dir, "stored-2.meta.json").delete()
        assertNull(store.readDashboard(2))
        assertNull(store.readMeta(2))

        // A meta without its dashboard is equally absent.
        store.write(2, source, dashboard)
        File(dir, "stored-2.json").delete()
        assertNull(store.readDashboard(2))
        assertNull(store.readMeta(2))

        // Stale temp files from a crash do not block the next write.
        File(dir, "stored-2.json.tmp").writeText("partial")
        File(dir, "stored-2.meta.json.tmp").writeText("partial")
        store.write(2, source, dashboard)
        assertArrayEquals(dashboard.toByteArray(Charsets.UTF_8), store.readDashboard(2))
        assertEquals(setOf("stored-2.json", "stored-2.meta.json"), dir.list()!!.toSet())
    }

    @Test
    fun `storeDashboard writes the slot of a current stored-mode remote dashboard`() {
        val spark = "http://192.168.192.16:8099/contracts/fixtures/spark-dashboard.json"
        val bundled = "http://androdash.local/dashboards/macos-node-dashboard.json"
        val config = AppConfig(dashboardUrl = spark, dashboardUrls = listOf(bundled, source, spark))
        assertEquals(1, DashboardStore.slotFor(config, source))
        assertEquals(2, DashboardStore.slotFor(config, spark))

        assertNull(DashboardStore.slotFor(config, null))
        assertNull(DashboardStore.slotFor(config, ""))
        assertNull(DashboardStore.slotFor(config, "$source?x=1"))
        assertNull(DashboardStore.slotFor(config, "http://evil.example/d.json"))
        assertNull(DashboardStore.slotFor(config.copy(dashboardSource = "url"), source))
        // Bundled dashboards are never stored, whatever their position.
        assertNull(DashboardStore.slotFor(config, bundled))
        val upper = "http://ANDRODASH.local/dashboards/macos-node-dashboard.json"
        assertNull(DashboardStore.slotFor(AppConfig(dashboardUrl = upper), upper))
        assertEquals(0, DashboardStore.slotFor(AppConfig(dashboardUrl = source), source))
    }

    private fun assertRejected(json: String) {
        try {
            store.write(0, source, json)
            fail("Expected IllegalArgumentException for ${json.take(40)}")
        } catch (_: IllegalArgumentException) {
            // expected
        }
    }
}
