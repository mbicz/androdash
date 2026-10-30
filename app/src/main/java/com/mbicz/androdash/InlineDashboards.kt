package com.mbicz.androdash

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.URI
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest

/**
 * Dashboards pasted in the settings sheet (C-007 `addInlineDashboard`). Each
 * one is the exact pasted text in `<filesDir>/inline/<id>.json`, where `id` is
 * the first 16 lowercase hex characters of the SHA-256 of its UTF-8 bytes, and
 * is served at `http://androdash.local/inline/<id>.json` ([AssetServer]). The
 * id is derived from the content, so no caller input ever becomes a path. The
 * JSON is untrusted: it is only checked to be a bounded JSON object; the
 * renderer normalizes it like any fetched dashboard (C-002).
 *
 * Files not referenced by `dashboard_urls` are removed by [prune]; at most
 * [MAX_FILES] are kept.
 */
class InlineDashboards(filesDir: File) {
    private val dir = File(filesDir, DIR_NAME)

    /**
     * Store [json] and return its virtual-origin URL. Unreferenced files (URLs
     * not in [referenced]) are removed first when [json] is new. Throws
     * [IllegalArgumentException] for input outside the contract (over
     * [DashboardStore.MAX_BYTES], not a single JSON object, or no room left
     * among [MAX_FILES]) and [IOException] when the file cannot be written.
     */
    @Synchronized
    fun write(json: String, referenced: Collection<String>): String {
        // Every char is at least one UTF-8 byte: reject huge input before encoding it.
        require(json.length <= DashboardStore.MAX_BYTES) { "dashboard exceeds ${DashboardStore.MAX_BYTES} bytes" }
        val bytes = json.toByteArray(Charsets.UTF_8)
        require(bytes.size <= DashboardStore.MAX_BYTES) { "dashboard exceeds ${DashboardStore.MAX_BYTES} bytes" }
        require(DashboardStore.isJsonObject(json)) { "dashboard is not a JSON object" }

        val id = idFor(bytes)
        val target = file(id)
        if (target.isFile) return url(id)
        prune(referenced)
        require(storedIds().size < MAX_FILES) { "at most $MAX_FILES inline dashboards" }
        if (!dir.isDirectory && !dir.mkdirs()) throw IOException("cannot create inline store")
        val temp = File(dir, "${target.name}$TEMP_SUFFIX")
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
        return url(id)
    }

    /** The bytes stored for [id], or null when [id] is malformed or nothing is stored. */
    @Synchronized
    fun read(id: String): ByteArray? {
        if (!ID.matches(id)) return null
        return try {
            file(id).takeIf { it.isFile }?.readBytes()
        } catch (_: IOException) {
            null
        }
    }

    /**
     * Delete every file in the store that is not an inline dashboard referenced
     * by [referenced] (leftover temp files included). Returns how many inline
     * dashboards were removed.
     */
    @Synchronized
    fun prune(referenced: Collection<String>): Int {
        val keep = referenced.mapNotNullTo(HashSet()) { idOf(it) }
        var removed = 0
        dir.listFiles()?.forEach { file ->
            val id = file.name.removeSuffix(SUFFIX).takeIf { file.name.endsWith(SUFFIX) && ID.matches(it) }
            if (id == null || id !in keep) {
                if (file.delete() && id != null) removed++
            }
        }
        return removed
    }

    private fun storedIds(): List<String> =
        dir.list().orEmpty().mapNotNull { name ->
            name.removeSuffix(SUFFIX).takeIf { name.endsWith(SUFFIX) && ID.matches(it) }
        }

    private fun file(id: String) = File(dir, "$id$SUFFIX")

    companion object {
        const val DIR_NAME = "inline"

        /** At most one inline file per possible `dashboard_urls` entry (C-001). */
        const val MAX_FILES = ConfigParser.MAX_DASHBOARDS
        const val URL_PREFIX = "http://${ConfigParser.HOST}/inline/"
        private const val SUFFIX = ".json"
        private const val TEMP_SUFFIX = ".tmp"
        private const val ID_BYTES = 8
        private val ID = Regex("^[0-9a-f]{16}$")
        private val PATH = Regex("^/inline/([0-9a-f]{16})\\.json$")

        /** Virtual-origin URL of the inline dashboard [id]. */
        fun url(id: String): String = "$URL_PREFIX$id$SUFFIX"

        /** First 16 lowercase hex characters of the SHA-256 of [bytes]. */
        fun idFor(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes)
                .take(ID_BYTES)
                .joinToString("") { "%02x".format(it.toInt() and 0xff) }

        /** The id of an inline dashboard URL (`http://androdash.local/inline/<id>.json`), else null. */
        fun idOf(url: String): String? = try {
            val uri = URI(url)
            if (uri.scheme.equals("http", ignoreCase = true) &&
                uri.host.equals(ConfigParser.HOST, ignoreCase = true) &&
                (uri.port == -1 || uri.port == 80)
            ) {
                PATH.matchEntire(uri.rawPath.orEmpty())?.groupValues?.get(1)
            } else {
                null
            }
        } catch (_: Exception) {
            null
        }
    }
}
