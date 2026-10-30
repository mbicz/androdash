package com.mbicz.androdash

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CollectorStatusTest {
    private val base = AppConfig(dashboardUrl = "http://androdash.local/dashboards/macos-node-dashboard.json")

    @Test
    fun `disabled collector reports no url but its configured targets`() {
        val json = JSONObject(CollectorStatus.of(base, CollectorRuntime()).toJson())
        assertFalse(json.getBoolean("enabled"))
        assertFalse(json.getBoolean("running"))
        assertTrue(json.isNull("url"))
        val phoneOnly = json.getJSONArray("targets")
        assertEquals(1, phoneOnly.length())
        assertEquals("phone", phoneOnly.getJSONObject(0).getString("job"))
        assertEquals("127.0.0.1:19100", phoneOnly.getJSONObject(0).getString("address"))
        assertEquals(0, json.getInt("restarts"))
        assertTrue(json.isNull("startedAt"))
        assertTrue(json.isNull("lastExit"))
        assertEquals(
            setOf("enabled", "running", "url", "targets", "restarts", "startedAt", "lastExit"),
            json.keys().asSequence().toSet(),
        )
    }

    @Test
    fun `disabled collector lists the phone job first, then collector_targets`() {
        val config = base.copy(collectorTargets = "node:mac=192.168.1.20:9100,gpu:spark=192.168.1.21:9400")
        val targets = JSONObject(CollectorStatus.of(config, CollectorRuntime()).toJson()).getJSONArray("targets")
        assertEquals(
            listOf("phone/phone/127.0.0.1:19100", "node/mac/192.168.1.20:9100", "gpu/spark/192.168.1.21:9400"),
            (0 until targets.length()).map { index ->
                targets.getJSONObject(index).let { "${it.getString("job")}/${it.getString("instance")}/${it.getString("address")}" }
            },
        )
        val noPhone = JSONObject(CollectorStatus.of(config.copy(collectorPhone = false), CollectorRuntime()).toJson())
        assertFalse(noPhone.getBoolean("enabled"))
        assertTrue(noPhone.isNull("url"))
        assertEquals(2, noPhone.getJSONArray("targets").length())
        assertEquals(0, JSONObject(CollectorStatus.of(base.copy(collectorPhone = false), CollectorRuntime()).toJson())
            .getJSONArray("targets").length())
    }

    @Test
    fun `null config is disabled`() {
        val json = JSONObject(CollectorStatus.of(null, CollectorRuntime()).toJson())
        assertFalse(json.getBoolean("enabled"))
        assertEquals(0, json.getJSONArray("targets").length())
    }

    @Test
    fun `running collector reports targets, url, and start time`() {
        val config = base.copy(collector = true, collectorTargets = "node:mac=192.168.192.16:9100")
        val runtime = CollectorRuntime(running = true, restarts = 2, startedAt = 1_761_600_000_000L, lastExit = "exited with code 1 after 3s")
        val json = JSONObject(CollectorStatus.of(config, runtime).toJson())
        assertTrue(json.getBoolean("enabled"))
        assertTrue(json.getBoolean("running"))
        assertEquals("http://127.0.0.1:19090", json.getString("url"))
        val targets = json.getJSONArray("targets")
        assertEquals(2, targets.length())
        val phone = targets.getJSONObject(0)
        assertEquals("phone", phone.getString("job"))
        assertEquals("phone", phone.getString("instance"))
        assertEquals("127.0.0.1:19100", phone.getString("address"))
        val target = targets.getJSONObject(1)
        assertEquals("node", target.getString("job"))
        assertEquals("mac", target.getString("instance"))
        assertEquals("192.168.192.16:9100", target.getString("address"))
        assertEquals(2, json.getInt("restarts"))
        assertEquals(1_761_600_000_000L, json.getLong("startedAt"))
        assertEquals("exited with code 1 after 3s", json.getString("lastExit"))
    }

    @Test
    fun `phone-only collector reports the phone target, collector_phone=false omits it`() {
        val phoneOnly = JSONObject(CollectorStatus.of(base.copy(collector = true), CollectorRuntime()).toJson())
        assertTrue(phoneOnly.getBoolean("enabled"))
        assertEquals(1, phoneOnly.getJSONArray("targets").length())
        assertEquals("phone", phoneOnly.getJSONArray("targets").getJSONObject(0).getString("job"))
        val noPhone = base.copy(collector = true, collectorTargets = "a.lan:9100", collectorPhone = false)
        val json = JSONObject(CollectorStatus.of(noPhone, CollectorRuntime()).toJson())
        assertEquals(1, json.getJSONArray("targets").length())
        assertEquals("node", json.getJSONArray("targets").getJSONObject(0).getString("job"))
    }

    @Test
    fun `startedAt is null while not running`() {
        val config = base.copy(collector = true, collectorTargets = "a.lan:9100")
        val json = JSONObject(CollectorStatus.of(config, CollectorRuntime(running = false, startedAt = 5L)).toJson())
        assertTrue(json.isNull("startedAt"))
    }

    @Test
    fun `payload stays within 4 KiB with 32 maximal targets`() {
        val host = "${"h".repeat(63)}.${"h".repeat(63)}.${"h".repeat(63)}.${"h".repeat(61)}"
        val targets = (1..32).joinToString(",") { "${"j".repeat(62)}${it.toString().padStart(2, '0')}:${"i".repeat(64)}=$host:65535" }
        val config = base.copy(collector = true, collectorTargets = targets)
        val runtime = CollectorRuntime(running = true, restarts = 7, startedAt = 1L, lastExit = "x".repeat(500))
        val text = CollectorStatus.of(config, runtime).toJson()
        assertTrue(text.toByteArray(Charsets.UTF_8).size <= CollectorStatus.MAX_BYTES)
        val json = JSONObject(text)
        assertTrue(json.getJSONArray("targets").length() in 1 until 32)
        assertEquals(CollectorStatus.MAX_LAST_EXIT, json.getString("lastExit").length)
    }

    @Test
    fun `lastExit is printable ASCII`() {
        assertEquals("a b c", CollectorStatus.sanitizeExit("a\nb\u0000c"))
    }

    @Test
    fun `fallback is valid JSON with the same keys`() {
        val json = JSONObject(CollectorStatus.UNAVAILABLE)
        assertEquals(
            setOf("enabled", "running", "url", "targets", "restarts", "startedAt", "lastExit"),
            json.keys().asSequence().toSet(),
        )
    }
}
