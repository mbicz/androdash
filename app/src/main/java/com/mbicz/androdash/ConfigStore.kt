package com.mbicz.androdash

import android.content.Context

/**
 * Persistence contract C-007: only the canonical AppConfig, in the named
 * preferences file/key, and only after validation succeeded.
 */
class ConfigStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun load(): AppConfig? = ConfigParser.decodePersisted(prefs.getString(KEY_CONFIG, null))

    fun save(config: AppConfig) {
        prefs.edit().putString(KEY_CONFIG, config.toJson()).apply()
    }

    fun clear() {
        prefs.edit().remove(KEY_CONFIG).apply()
    }

    companion object {
        const val PREFS_NAME = "androdash"
        const val KEY_CONFIG = "launch_config"
    }
}
