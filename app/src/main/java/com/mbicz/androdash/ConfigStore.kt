package com.mbicz.androdash

import android.content.Context

/**
 * Persistence contract C-007: the canonical AppConfig, in the named
 * preferences file/key, only after validation succeeded; plus the native-only
 * preferences under their own keys (they are not part of AppConfig):
 * `show_when_locked`, and the provisioning state from decision 0027 (the
 * device code and, in `ignition_wait` mode, the Ignition URL template that is
 * polled every `ignition_wait_seconds`, decision 0028).
 */
class ConfigStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun load(): AppConfig? = ConfigParser.decodePersisted(prefs.getString(KEY_CONFIG, null))

    fun save(config: AppConfig) {
        prefs.edit().putString(KEY_CONFIG, config.toJson()).apply()
    }

    fun loadShowWhenLocked(): Boolean = prefs.getBoolean(KEY_SHOW_WHEN_LOCKED, false)

    fun saveShowWhenLocked(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_SHOW_WHEN_LOCKED, enabled).apply()
    }

    /** The six-digit provisioning code, generated once on first use (decision 0027). */
    fun deviceCode(random: java.util.Random): String {
        val stored = prefs.getString(KEY_DEVICE_CODE, null)
        if (DeviceCode.isCode(stored)) return stored!!
        val generated = DeviceCode.generate(random)
        prefs.edit().putString(KEY_DEVICE_CODE, generated).apply()
        return generated
    }

    /** The `ignition_url` template polled in wait mode, or null in one-shot mode. */
    fun loadIgnitionUrl(): String? = prefs.getString(KEY_IGNITION_URL, null)?.takeIf { it.isNotBlank() }

    fun loadIgnitionWaitSeconds(): Int =
        prefs.getInt(KEY_IGNITION_WAIT_SECONDS, Provisioning.DEFAULT_WAIT_SECONDS)

    /** Enter `ignition_wait` mode: keep [url] and poll it every [waitSeconds]. */
    fun saveProvisioning(url: String, waitSeconds: Int) {
        prefs.edit()
            .putString(KEY_IGNITION_URL, url)
            .putInt(KEY_IGNITION_WAIT_SECONDS, waitSeconds)
            .apply()
    }

    /** Leave `ignition_wait` mode: polling stops and a relaunch does not fetch. */
    fun clearProvisioning() {
        prefs.edit().remove(KEY_IGNITION_URL).remove(KEY_IGNITION_WAIT_SECONDS).apply()
    }

    fun clear() {
        prefs.edit().remove(KEY_CONFIG).remove(KEY_SHOW_WHEN_LOCKED).apply()
    }

    companion object {
        const val PREFS_NAME = "androdash"
        const val KEY_CONFIG = "launch_config"
        const val KEY_SHOW_WHEN_LOCKED = "show_when_locked"
        /** Native-only, decision 0027. */
        const val KEY_DEVICE_CODE = "device_code"
        const val KEY_IGNITION_URL = "ignition_url"
        const val KEY_IGNITION_WAIT_SECONDS = "ignition_wait_seconds"
    }
}
