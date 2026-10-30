package com.mbicz.androdash

import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class InlineDashboardsTest {
    private val filesDir: File = Files.createTempDirectory("androdash-inline").toFile()
    private val store = InlineDashboards(filesDir)
    private val dir = File(filesDir, InlineDashboards.DIR_NAME)
    private val dashboard = """{"kind":"Dashboard","metadata":{"name":"pasted ✓"},"spec":{"panels":{}}}"""

    @After
    fun cleanUp() {
        filesDir.deleteRecursively()
    }

    @Test
    fun `write stores the exact text under the first 16 hex of its SHA-256`() {
        val url = store.write(dashboard, emptyList())

        val bytes = dashboard.toByteArray(Charsets.UTF_8)
        val hex = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val id = hex.take(16)
        assertEquals("http://androdash.local/inline/$id.json", url)
        assertEquals(id, InlineDashboards.idOf(url))
        assertArrayEquals(bytes, store.read(id))
        assertEquals(setOf("$id.json"), dir.list()!!.toSet())
    }

    @Test
    fun `same content gets the same id and different content another`() {
        val first = store.write(dashboard, emptyList())
        assertEquals(first, store.write(dashboard, emptyList()))
        val other = store.write("""{"kind":"Dashboard"}""", listOf(first))
        assertNotEquals(first, other)
        // Whitespace is content: the exact text is kept.
        assertNotEquals(first, store.write(" $dashboard", listOf(first, other)))
        assertEquals(3, dir.list()!!.size)
    }

    @Test
    fun `non-object JSON is rejected`() {
        listOf("", "[]", "\"x\"", "42", "null", "{", "{} {}", "{}x", "not json").forEach { json ->
            assertRejected { store.write(json, emptyList()) }
        }
        assertTrue(!dir.exists() || dir.list()!!.isEmpty())
    }

    @Test
    fun `oversize input is rejected`() {
        val padding = DashboardStore.MAX_BYTES - """{"a":""}""".length
        val exact = """{"a":"${"x".repeat(padding)}"}"""
        assertEquals(DashboardStore.MAX_BYTES, exact.length)
        store.write(exact, emptyList())

        assertRejected { store.write("""{"a":"${"x".repeat(padding + 1)}"}""", emptyList()) }
        // Within the character limit but over it in UTF-8 bytes.
        assertRejected { store.write("""{"a":"${"é".repeat(padding)}"}""", emptyList()) }
    }

    @Test
    fun `prune keeps only dashboards referenced by dashboard_urls`() {
        val kept = store.write(dashboard, emptyList())
        val dropped = store.write("""{"kind":"Dashboard"}""", listOf(kept))
        File(dir, "${InlineDashboards.idOf(kept)}.json.tmp").writeText("partial")
        File(dir, "stray.txt").writeText("x")

        val removed = store.prune(listOf("http://192.168.1.20:8099/d.json", kept, "http://androdash.local/dashboards/a.json"))

        assertEquals(1, removed)
        assertEquals(setOf("${InlineDashboards.idOf(kept)}.json"), dir.list()!!.toSet())
        assertNull(store.read(InlineDashboards.idOf(dropped)!!))
        assertEquals(1, store.prune(emptyList()))
        assertEquals(0, dir.list()!!.size)
    }

    @Test
    fun `at most 8 files are kept and unreferenced ones make room`() {
        val urls = (1..8).map { store.write("""{"n":$it}""", (1 until it).map { n -> urlOf("""{"n":$n}""") }) }
        assertEquals(8, dir.list()!!.size)
        // All eight referenced: no room for a ninth.
        assertRejected { store.write("""{"n":9}""", urls) }
        // An already stored dashboard is still accepted.
        assertEquals(urls[0], store.write("""{"n":1}""", urls))
        // Dropping one reference makes room.
        val ninth = store.write("""{"n":9}""", urls.drop(1))
        assertEquals(8, dir.list()!!.size)
        assertNull(store.read(InlineDashboards.idOf(urls[0])!!))
        assertArrayEquals("""{"n":9}""".toByteArray(), store.read(InlineDashboards.idOf(ninth)!!))
    }

    @Test
    fun `read and idOf accept only well-formed ids`() {
        store.write(dashboard, emptyList())
        listOf("", "../x", "0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0").forEach {
            assertNull(store.read(it))
        }
        assertEquals("0123456789abcdef", InlineDashboards.idOf("http://androdash.local/inline/0123456789abcdef.json"))
        assertEquals("0123456789abcdef", InlineDashboards.idOf("http://ANDRODASH.local:80/inline/0123456789abcdef.json"))
        listOf(
            "https://androdash.local/inline/0123456789abcdef.json",
            "http://androdash.local:8080/inline/0123456789abcdef.json",
            "http://example.com/inline/0123456789abcdef.json",
            "http://androdash.local/dashboards/0123456789abcdef.json",
            "http://androdash.local/inline/0123456789ABCDEF.json",
            "not a url",
        ).forEach { assertNull(it, InlineDashboards.idOf(it)) }
    }

    private fun urlOf(json: String): String =
        InlineDashboards.url(InlineDashboards.idFor(json.toByteArray(Charsets.UTF_8)))

    private fun assertRejected(block: () -> Unit) {
        try {
            block()
            fail("Expected IllegalArgumentException")
        } catch (_: IllegalArgumentException) {
        }
    }
}
