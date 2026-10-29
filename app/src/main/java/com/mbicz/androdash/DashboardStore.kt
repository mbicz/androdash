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
 * Stored copies of remote dashboards (C-001 `dashboard_source=stored`, C-008).
 * [SLOTS] fixed slots, one per position in `dashboard_urls`; slot `i` is the
 * fixed pair `stored-<i>.json` + `stored-<i>.meta.json` under
 * `<filesDir>/dashboards/`. The slot is a bounded integer, so no caller input
 * ever becomes a path. The JSON is untrusted: it is only checked to be a
 * bounded JSON object and is served back verbatim to the renderer, which
 * normalizes it like any fetched dashboard (C-002).
 *
 * Write order keeps each pair consistent: the old meta is removed first, the
 * dashboard is renamed into place, and the meta is renamed in last. A dashboard
 * is only readable while its meta exists, so an interrupted write reads as
 * "nothing stored" and the renderer fetches again.
 */
class DashboardStore(
    filesDir: File,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val dir = File(filesDir, DIR_NAME)

    /**
     * Store [json] in [slot] as the dashboard fetched from [sourceUrl]. Throws
     * [IllegalArgumentException] for input outside the contract (slot outside
     * `0 until SLOTS`, over [MAX_BYTES] UTF-8, not a single JSON object) and
     * [IOException] when the files cannot be written. Returns the stored byte
     * count.
     */
    @Synchronized
    fun write(slot: Int, sourceUrl: String, json: String): Int {
        require(slot in 0 until SLOTS) { "slot must be 0 to ${SLOTS - 1}" }
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

        val metaFile = metaFile(slot)
        if (!dir.isDirectory && !dir.mkdirs()) throw IOException("cannot create dashboard store")
        if (metaFile.exists() && !metaFile.delete()) throw IOException("cannot replace stored meta")
        replace(dashboardFile(slot), bytes)
        replace(metaFile, meta)
        return bytes.size
    }

    /** The dashboard bytes stored in [slot], or null when nothing (complete) is stored there. */
    @Synchronized
    fun readDashboard(slot: Int): ByteArray? {
        if (slot !in 0 until SLOTS || !metaFile(slot).isFile) return null
        return readOrNull(dashboardFile(slot))
    }

    /** The `{"sourceUrl", "storedAt", "bytes"}` meta bytes of [slot], or null when nothing is stored there. */
    @Synchronized
    fun readMeta(slot: Int): ByteArray? {
        if (slot !in 0 until SLOTS || !dashboardFile(slot).isFile) return null
        return readOrNull(metaFile(slot))
    }

    /** Clear every slot. */
    @Synchronized
    fun clear() {
        for (slot in 0 until SLOTS) {
            // Meta first: a dashboard without meta already reads as absent.
            val meta = metaFile(slot)
            val dashboard = dashboardFile(slot)
            meta.delete()
            dashboard.delete()
            tempFile(meta).delete()
            tempFile(dashboard).delete()
        }
    }

    /** Delete the single-copy files of the pre-slot store (decision 0018). Call once at startup. */
    @Synchronized
    fun removeLegacy() {
        LEGACY_FILES.forEach { name ->
            File(dir, name).delete()
            File(dir, "$name$TEMP_SUFFIX").delete()
        }
    }

    private fun dashboardFile(slot: Int) = File(dir, "$FILE_PREFIX$slot.json")

    private fun metaFile(slot: Int) = File(dir, "$FILE_PREFIX$slot.meta.json")

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
        /** Upper bound on one stored dashboard, in UTF-8 bytes (C-007 `storeDashboard`). */
        const val MAX_BYTES = 5 * 1024 * 1024

        /** One slot per possible `dashboard_urls` entry (C-001). */
        const val SLOTS = ConfigParser.MAX_DASHBOARDS
        const val DIR_NAME = "dashboards"
        const val FILE_PREFIX = "stored-"
        private const val TEMP_SUFFIX = ".tmp"
        private val LEGACY_FILES = listOf("stored.json", "stored.meta.json")

        /**
         * C-007 `storeDashboard` gate: the slot of [sourceUrl] in the current
         * `dashboard_urls`, only in `stored` mode, and never for a bundled
         * virtual-origin URL; null when the store is refused.
         */
        fun slotFor(config: AppConfig, sourceUrl: String?): Int? {
            if (sourceUrl.isNullOrEmpty() || config.dashboardSource != "stored") return null
            if (isVirtualOrigin(sourceUrl)) return null
            val slot = config.dashboardUrls.indexOf(sourceUrl)
            return if (slot in 0 until SLOTS) slot else null
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
