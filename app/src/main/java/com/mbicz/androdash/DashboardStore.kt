package com.mbicz.androdash

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.URI
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import org.json.JSONObject
import org.json.JSONTokener

/**
 * The stored copy of a remote dashboard (C-001 `dashboard_source=stored`,
 * C-008). One fixed pair of files under `<filesDir>/dashboards/`; no caller
 * input ever becomes a path. The JSON is untrusted: it is only checked to be a
 * bounded JSON object and is served back verbatim to the renderer, which
 * normalizes it like any fetched dashboard (C-002).
 *
 * Write order keeps the pair consistent: the old meta is removed first, the
 * dashboard is renamed into place, and the meta is renamed in last. The
 * dashboard is only readable while its meta exists, so an interrupted write
 * reads as "nothing stored" and the renderer fetches again.
 */
class DashboardStore(
    filesDir: File,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val dir = File(filesDir, DIR_NAME)
    private val dashboardFile = File(dir, DASHBOARD_FILE)
    private val metaFile = File(dir, META_FILE)

    /**
     * Store [json] as the dashboard fetched from [sourceUrl]. Throws
     * [IllegalArgumentException] for input outside the contract (over
     * [MAX_BYTES] UTF-8, not a single JSON object) and [IOException] when the
     * files cannot be written. Returns the stored byte count.
     */
    @Synchronized
    fun write(sourceUrl: String, json: String): Int {
        require(sourceUrl.isNotEmpty()) { "sourceUrl must not be empty" }
        // Every char is at least one UTF-8 byte: reject huge input before encoding it.
        require(json.length <= MAX_BYTES) { "dashboard exceeds $MAX_BYTES bytes" }
        val bytes = json.toByteArray(Charsets.UTF_8)
        require(bytes.size <= MAX_BYTES) { "dashboard exceeds $MAX_BYTES bytes" }
        require(isJsonObject(json)) { "dashboard is not a JSON object" }

        val meta = JSONObject()
            .put("sourceUrl", sourceUrl)
            .put("storedAt", clock())
            .put("bytes", bytes.size)
            .toString()
            .toByteArray(Charsets.UTF_8)

        if (!dir.isDirectory && !dir.mkdirs()) throw IOException("cannot create dashboard store")
        if (metaFile.exists() && !metaFile.delete()) throw IOException("cannot replace stored meta")
        replace(dashboardFile, bytes)
        replace(metaFile, meta)
        return bytes.size
    }

    /** The stored dashboard bytes, or null when nothing (complete) is stored. */
    @Synchronized
    fun readDashboard(): ByteArray? {
        if (!metaFile.isFile) return null
        return readOrNull(dashboardFile)
    }

    /** The `{"sourceUrl", "storedAt", "bytes"}` meta bytes, or null when nothing is stored. */
    @Synchronized
    fun readMeta(): ByteArray? {
        if (!dashboardFile.isFile) return null
        return readOrNull(metaFile)
    }

    @Synchronized
    fun clear() {
        // Meta first: a dashboard without meta already reads as absent.
        metaFile.delete()
        dashboardFile.delete()
        tempFile(metaFile).delete()
        tempFile(dashboardFile).delete()
    }

    private fun replace(target: File, bytes: ByteArray) {
        val temp = tempFile(target)
        try {
            FileOutputStream(temp).use { out ->
                out.write(bytes)
                out.fd.sync()
            }
            Files.move(
                temp.toPath(),
                target.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
        } finally {
            temp.delete()
        }
    }

    private fun readOrNull(file: File): ByteArray? = try {
        if (file.isFile) file.readBytes() else null
    } catch (_: IOException) {
        null
    }

    private fun tempFile(target: File) = File(dir, "${target.name}$TEMP_SUFFIX")

    companion object {
        /** Upper bound on the stored dashboard, in UTF-8 bytes (C-007 `storeDashboard`). */
        const val MAX_BYTES = 5 * 1024 * 1024
        const val DIR_NAME = "dashboards"
        const val DASHBOARD_FILE = "stored.json"
        const val META_FILE = "stored.meta.json"
        private const val TEMP_SUFFIX = ".tmp"

        /**
         * C-007 `storeDashboard` gate: only the dashboard the shell was told to
         * load, only in `stored` mode, and never a bundled virtual-origin URL.
         */
        fun acceptsSource(config: AppConfig, sourceUrl: String?): Boolean {
            if (sourceUrl.isNullOrEmpty() || sourceUrl != config.dashboardUrl) return false
            if (config.dashboardSource != "stored") return false
            return !isVirtualOrigin(sourceUrl)
        }

        fun isVirtualOrigin(url: String): Boolean = try {
            URI(url).host.equals(ConfigParser.HOST, ignoreCase = true)
        } catch (_: Exception) {
            false
        }

        private fun isJsonObject(json: String): Boolean = try {
            val tokener = JSONTokener(json)
            tokener.nextValue() is JSONObject && tokener.nextClean() == 0.toChar()
        } catch (_: Exception) {
            false
        }
    }
}
