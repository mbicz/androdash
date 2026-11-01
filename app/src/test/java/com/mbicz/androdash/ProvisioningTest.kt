package com.mbicz.androdash

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.Random

class ProvisioningTest {
    private val code = "482913"
    private val deviceId = "3a7bd3e2"

    private fun resolve(
        template: String,
        model: String? = "Google Pixel 4a (5G)",
        ip: String? = "192.168.1.50",
    ): String = Provisioning.resolve(template, code, deviceId, model, ip)

    private fun reject(template: String): String {
        try {
            resolve(template)
            fail("expected E_IGNITION_FETCH for $template")
        } catch (error: ConfigException) {
            return error.code
        }
        return ""
    }

    @Test
    fun `device code is six digits in the documented range`() {
        val random = Random(7)
        repeat(200) {
            val generated = DeviceCode.generate(random)
            assertTrue(generated, DeviceCode.isCode(generated))
            assertTrue(generated.toInt() in 100000..999999)
        }
    }

    @Test
    fun `device code validation rejects anything else`() {
        assertFalse(DeviceCode.isCode(null))
        assertFalse(DeviceCode.isCode(""))
        assertFalse(DeviceCode.isCode("12345"))
        assertFalse(DeviceCode.isCode("1234567"))
        assertFalse(DeviceCode.isCode("12345a"))
        assertFalse(DeviceCode.isCode(" 482913"))
    }

    @Test
    fun `device id is eight lowercase hex characters of the hash`() {
        val id = Provisioning.deviceId("7ad3f4c55f49e4e0")
        assertEquals(8, id.length)
        assertTrue(id.matches(Regex("^[0-9a-f]{8}$")))
        assertEquals(id, Provisioning.deviceId("7ad3f4c55f49e4e0"))
        assertTrue(Provisioning.deviceId(null).matches(Regex("^[0-9a-f]{8}$")))
    }

    @Test
    fun `device token is substituted and identity is appended`() {
        assertEquals(
            "http://192.168.1.20:8099/ignition/482913.json" +
                "?device_code=482913&device_model=Google%20Pixel%204a%20%285G%29&device_ip=192.168.1.50",
            resolve("http://192.168.1.20:8099/ignition/{device}.json"),
        )
    }

    @Test
    fun `device id token is substituted`() {
        assertEquals(
            "http://192.168.1.20:8099/ignition/3a7bd3e2.json" +
                "?device_code=482913&device_model=Google%20Pixel%204a%20%285G%29&device_ip=192.168.1.50",
            resolve("http://192.168.1.20:8099/ignition/{deviceId}.json"),
        )
    }

    @Test
    fun `existing query parameters are kept and not duplicated`() {
        assertEquals(
            "http://192.168.1.20:8099/ignition?site=lobby&device_code=482913" +
                "&device_model=Google%20Pixel%204a%20%285G%29&device_ip=192.168.1.50",
            resolve("http://192.168.1.20:8099/ignition?site=lobby"),
        )
        assertEquals(
            "http://192.168.1.20:8099/ignition?device_code=999999" +
                "&device_model=Google%20Pixel%204a%20%285G%29&device_ip=192.168.1.50",
            resolve("http://192.168.1.20:8099/ignition?device_code=999999"),
        )
    }

    @Test
    fun `offline device omits the ip parameter`() {
        assertEquals(
            "http://192.168.1.20:8099/ignition?device_code=482913&device_model=Google%20Pixel%204a%20%285G%29",
            resolve("http://192.168.1.20:8099/ignition", ip = null),
        )
    }

    @Test
    fun `unknown token is rejected as a fetch failure`() {
        assertEquals("E_IGNITION_FETCH", reject("http://192.168.1.20:8099/{serial}.json"))
        assertEquals("E_IGNITION_FETCH", reject("http://192.168.1.20:8099/{}.json"))
    }

    @Test
    fun `invalid template shapes are fetch failures`() {
        assertEquals("E_IGNITION_FETCH", reject("ftp://192.168.1.20/ignition/{device}.json"))
        assertEquals("E_IGNITION_FETCH", reject("http:///ignition/{device}.json"))
        assertEquals("E_IGNITION_FETCH", reject("http://user:pass@192.168.1.20/{device}.json"))
        assertEquals("E_IGNITION_FETCH", reject("http://192.168.1.20/ignition/{device}.json#frag"))
        assertEquals(
            "E_IGNITION_FETCH",
            reject("http://192.168.1.20/8099/" + "x".repeat(8200) + "/{device}.json"),
        )
    }

    @Test
    fun `wait seconds bounds are enforced by the parser`() {
        val extras = mapOf("ignition_wait" to "true", "ignition_url" to "http://192.168.1.20/ignition/{device}.json")
        assertEquals(
            15,
            ConfigParser.parseProvisioning(extras, null, Provisioning.DEFAULT_WAIT_SECONDS).waitSeconds,
        )
        assertEquals(
            1,
            ConfigParser.parseProvisioning(extras + ("ignition_wait_seconds" to "1"), null, 15).waitSeconds,
        )
        assertEquals(
            300,
            ConfigParser.parseProvisioning(extras + ("ignition_wait_seconds" to "300"), null, 15).waitSeconds,
        )
        for (bad in listOf("0", "301", "-1", "abc")) {
            try {
                ConfigParser.parseProvisioning(extras + ("ignition_wait_seconds" to bad), null, 15)
                fail("expected E_CONFIG for ignition_wait_seconds=$bad")
            } catch (error: ConfigException) {
                assertEquals("E_CONFIG", error.code)
            }
        }
    }

    @Test
    fun `wait mode reuses the persisted template and clears it on opt-out`() {
        val template = "http://192.168.1.20/ignition/{device}.json"
        val persisted = ConfigParser.parseProvisioning(emptyMap(), template, 20)
        assertEquals(template, persisted.template)
        assertTrue(persisted.wait)
        assertEquals(20, persisted.waitSeconds)

        val oneShot = ConfigParser.parseProvisioning(
            mapOf("ignition_wait" to "false"),
            template,
            20,
        )
        assertNull(oneShot.template)
        assertFalse(oneShot.wait)

        val explicit = ConfigParser.parseProvisioning(
            mapOf("ignition_url" to "http://192.168.1.20:8099/ignition.json"),
            template,
            20,
        )
        assertEquals("http://192.168.1.20:8099/ignition.json", explicit.template)
        assertFalse(explicit.wait)
    }

    @Test
    fun `wait mode without any url is a config error`() {
        try {
            ConfigParser.parseProvisioning(mapOf("ignition_wait" to "true"), null, 15)
            fail("expected E_CONFIG")
        } catch (error: ConfigException) {
            assertEquals("E_CONFIG", error.code)
        }
    }

    @Test
    fun `document digest is stable hex and detects a changed document`() {
        val body = """{"schemaVersion":1,"dashboards":{"urls":["http://192.168.1.20:8099/d.json"]}}"""
        val digest = Provisioning.documentDigest(body)
        assertEquals(64, digest.length)
        assertTrue(digest.matches(Regex("^[0-9a-f]{64}$")))
        assertTrue("the same body is a no-op poll", digest == Provisioning.documentDigest(body))
        assertTrue(digest != Provisioning.documentDigest("$body "))
        assertTrue(digest != Provisioning.documentDigest(body.replace("8099", "9090")))
    }

    @Test
    fun `provisioning extras are launch extras`() {
        assertTrue(ConfigParser.hasConfigExtras(mapOf("ignition_wait" to "true")))
        assertTrue(ConfigParser.hasConfigExtras(mapOf("ignition_wait_seconds" to "30")))
        assertTrue(
            !ConfigParser.keepsRenderer(
                mapOf("ignition_url" to "http://192.168.1.20/ignition/{device}.json"),
                ConfigParser.LAUNCH_URL,
                ConfigParser.LAUNCH_URL,
            ),
        )
    }
}
