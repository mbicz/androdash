package com.mbicz.androdash

import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Random

/**
 * The device identity a phone presents to a provisioning server (C-001
 * [Ignition](docs/contracts/C-001-launch-config.md#ignition), decision 0027).
 *
 * The primary identity is a six-digit code the app generates once and keeps in
 * its preferences. It is short enough to read off the phone screen and type into
 * a server, and it survives app updates and in-app config changes. A MAC address
 * is not usable on modern Android (unreadable, per-SSID randomised), and
 * `ANDROID_ID` is a stable fingerprint, so it is offered only as the opt-in
 * `{deviceId}` token, never printed by default.
 */
object DeviceCode {
    const val MIN = 100000
    const val RANGE = 900000

    private val SIX_DIGITS = Regex("^[0-9]{6}$")

    /** One code in `100000…999999`; [random] is the caller's source of entropy. */
    fun generate(random: Random): String = (MIN + random.nextInt(RANGE)).toString()

    /** True when [value] is a six-digit code this app could have generated. */
    fun isCode(value: String?): Boolean = value != null && SIX_DIGITS.matches(value)
}

/**
 * Pure provisioning-URL rules: token substitution, the identity query
 * parameters the shell appends, and the `{deviceId}` derivation. Kept free of
 * Android APIs so the unit tests run on the JVM.
 */
object Provisioning {
    const val TOKEN_DEVICE = "{device}"
    const val TOKEN_DEVICE_ID = "{deviceId}"

    const val QUERY_DEVICE_CODE = "device_code"
    const val QUERY_DEVICE_MODEL = "device_model"
    const val QUERY_DEVICE_IP = "device_ip"

    /** Same cap as a dashboard URL (C-001). */
    const val MAX_URL = 8192

    /** `ignition_wait_seconds` default and bounds (C-001). */
    const val DEFAULT_WAIT_SECONDS = 15
    const val MIN_WAIT_SECONDS = 1
    const val MAX_WAIT_SECONDS = 300

    private val ANY_TOKEN = Regex("\\{[^{}]*\\}")
    private val MAX_TOKEN_IN_MESSAGE = 24

    /**
     * Resolve an `ignition_url` template into the URL the shell fetches:
     * `{device}` becomes [code], `{deviceId}` becomes [deviceId], and
     * `device_code`, `device_model`, and `device_ip` are appended as query
     * parameters when the URL does not already carry them.
     *
     * An unrecognised token, a fragment, an over-long result, and any
     * resulting value that is not an absolute http(s) URL with a host and no
     * userinfo are `E_IGNITION_FETCH`.
     */
    fun resolve(
        template: String,
        code: String,
        deviceId: String,
        model: String?,
        ip: String?,
    ): String {
        val substituted = ANY_TOKEN.replace(template) { match ->
            when (match.value) {
                TOKEN_DEVICE -> code
                TOKEN_DEVICE_ID -> deviceId
                else -> throw ConfigException(
                    Ignition.CODE_FETCH,
                    "ignition_url has an unknown token ${match.value.take(MAX_TOKEN_IN_MESSAGE)}",
                )
            }
        }
        if (substituted.contains('#')) {
            throw ConfigException(Ignition.CODE_FETCH, "ignition_url must not contain a fragment")
        }
        val withIdentity = appendIdentity(substituted, code, model, ip)
        if (withIdentity.length > MAX_URL) {
            throw ConfigException(Ignition.CODE_FETCH, "ignition_url exceeds $MAX_URL characters")
        }
        return try {
            ConfigParser.validateHttpUrl(withIdentity, "ignition_url")
        } catch (error: ConfigException) {
            throw ConfigException(Ignition.CODE_FETCH, error.message.orEmpty())
        }
    }

    /**
     * First 8 hex characters of SHA-256 of the platform device id: stable across
     * app updates and reinstallations, and not the raw fingerprint.
     */
    fun deviceId(androidId: String?): String {
        val seed = if (androidId.isNullOrBlank()) "unknown" else androidId
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(seed.toByteArray(StandardCharsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }.take(8)
    }

    private fun appendIdentity(url: String, code: String, model: String?, ip: String?): String {
        val query = url.substringAfter('?', "")
        val present = query.split('&')
            .map { it.substringBefore('=') }
            .filter { it.isNotEmpty() }
            .toSet()
        val extra = LinkedHashMap<String, String>()
        if (QUERY_DEVICE_CODE !in present) extra[QUERY_DEVICE_CODE] = code
        if (model != null && QUERY_DEVICE_MODEL !in present) extra[QUERY_DEVICE_MODEL] = model
        if (ip != null && QUERY_DEVICE_IP !in present) extra[QUERY_DEVICE_IP] = ip
        if (extra.isEmpty()) return url
        val separator = when {
            '?' !in url -> "?"
            query.isEmpty() -> ""
            url.endsWith("?") || url.endsWith("&") -> ""
            else -> "&"
        }
        val appended = extra.entries.joinToString("&") { "${it.key}=${encode(it.value)}" }
        return url + separator + appended
    }

    /** Query-value percent-encoding with `%20` for spaces (`URLEncoder` emits `+`). */
    private fun encode(value: String): String =
        URLEncoder.encode(value, StandardCharsets.UTF_8.name()).replace("+", "%20")
}
