package com.mbicz.androdash

import android.content.res.AssetManager
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream

/**
 * Serves the trusted renderer, the bundled dashboards (and their generated
 * `dashboards/index.json`), the stored dashboard slots, and the pasted inline
 * dashboards from the virtual origin. No file:// access and no directory
 * traversal: only the explicit routes in [route] are reachable, the stored
 * copies live under fixed file names in [DashboardStore], and inline files
 * under content-hash names in [InlineDashboards].
 */
class AssetServer(
    private val assets: AssetManager,
    private val store: DashboardStore,
    private val inline: InlineDashboards,
) {
    fun intercept(request: WebResourceRequest): WebResourceResponse? {
        val uri = request.url
        if (!isLocal(uri)) return null
        if (request.method != "GET" && request.method != "HEAD") {
            return textResponse(405, "Method not allowed")
        }

        return when (val route = route(uri.path.orEmpty())) {
            Route.BadPath -> textResponse(400, "Bad path")
            Route.NotFound -> textResponse(404, "Not found")
            is Route.StoredDashboard -> stored(store.readDashboard(route.slot))
            is Route.StoredMeta -> stored(store.readMeta(route.slot))
            is Route.Inline -> stored(inline.read(route.id))
            is Route.Asset -> try {
                ok(mimeType(route.path), assets.open(route.path, AssetManager.ACCESS_STREAMING))
            } catch (_: IOException) {
                textResponse(404, "Not found")
            }
        }
    }

    private fun stored(bytes: ByteArray?): WebResourceResponse =
        if (bytes == null) {
            textResponse(404, "Not found")
        } else {
            ok("application/json", ByteArrayInputStream(bytes))
        }

    private fun ok(mime: String, stream: InputStream): WebResourceResponse =
        WebResourceResponse(mime, "utf-8", 200, "OK", ASSET_HEADERS, stream)

    private fun textResponse(status: Int, message: String): WebResourceResponse =
        WebResourceResponse(
            "text/plain",
            "utf-8",
            status,
            if (status == 200) "OK" else "Error",
            mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff"),
            ByteArrayInputStream(message.toByteArray(Charsets.UTF_8)),
        )

    private fun mimeType(path: String): String = when {
        path.endsWith(".html") -> "text/html"
        path.endsWith(".css") -> "text/css"
        path.endsWith(".js") || path.endsWith(".mjs") -> "text/javascript"
        path.endsWith(".json") -> "application/json"
        else -> "application/octet-stream"
    }

    sealed interface Route {
        data object BadPath : Route
        data object NotFound : Route
        data class StoredDashboard(val slot: Int) : Route
        data class StoredMeta(val slot: Int) : Route

        /** A pasted dashboard in [InlineDashboards]; [id] is 16 lowercase hex characters. */
        data class Inline(val id: String) : Route

        /** A bundled asset, relative to the APK assets root. */
        data class Asset(val path: String) : Route
    }

    companion object {
        const val HOST = ConfigParser.HOST
        /** `/stored/<slot>/dashboard.json` and `/stored/<slot>/meta.json`, slot `0..7`. */
        private val STORED = Regex("^/stored/([0-7])/(dashboard|meta)\\.json$")
        /** `/inline/<id>.json`, id = 16 lowercase hex characters. */
        private val INLINE = Regex("^/inline/([0-9a-f]{16})\\.json$")
        private val ALLOWED = Regex(
            "^(index\\.html|styles\\.css|src/[A-Za-z0-9_./-]+\\.js|dashboards/[A-Za-z0-9_.-]+\\.json)$",
        )
        private val ASSET_HEADERS = mapOf(
            "Cache-Control" to "no-store",
            "X-Content-Type-Options" to "nosniff",
            "X-Frame-Options" to "DENY",
        )

        /** Map a virtual-origin URL path to what serves it. Pure; unit-tested. */
        fun route(path: String): Route {
            if (path.contains("..") || path.contains('\\') || path.contains('%') || path.contains("//")) {
                return Route.BadPath
            }
            STORED.matchEntire(path)?.let { match ->
                val slot = match.groupValues[1].toInt()
                return if (match.groupValues[2] == "dashboard") {
                    Route.StoredDashboard(slot)
                } else {
                    Route.StoredMeta(slot)
                }
            }
            INLINE.matchEntire(path)?.let { return Route.Inline(it.groupValues[1]) }
            return when (path) {
                "", "/" -> Route.Asset("index.html")
                else -> {
                    val assetPath = path.removePrefix("/")
                    if (ALLOWED.matches(assetPath)) Route.Asset(assetPath) else Route.NotFound
                }
            }
        }

        fun isLocal(uri: Uri): Boolean =
            uri.scheme.equals("http", ignoreCase = true) &&
                uri.host.equals(HOST, ignoreCase = true) &&
                (uri.port == -1 || uri.port == 80)
    }
}
