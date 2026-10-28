package com.mbicz.androdash

import android.content.Context

/**
 * Persistence contract C-007: the canonical AppConfig, in the named
 * preferences file/key, only after validation succeeded; plus the native-only
 * `show_when_locked` preference under its own key (it is not part of AppConfig).
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

    fun clear() {
        prefs.edit().remove(KEY_CONFIG).remove(KEY_SHOW_WHEN_LOCKED).apply()
    }

    companion object {
        const val PREFS_NAME = "androdash"
        const val KEY_CONFIG = "launch_config"
        const val KEY_SHOW_WHEN_LOCKED = "show_when_locked"
    }
}
