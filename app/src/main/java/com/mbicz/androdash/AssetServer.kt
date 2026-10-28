package com.mbicz.androdash

import android.content.res.AssetManager
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream

/**
 * Serves the trusted renderer, the bundled dashboards, and the stored
 * dashboard copy from the virtual origin. No file:// access and no directory
 * traversal: only the explicit routes in [route] are reachable, and the stored
 * copy lives under fixed file names in [DashboardStore].
 */
class AssetServer(
    private val assets: AssetManager,
    private val store: DashboardStore,
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
            Route.StoredDashboard -> stored(store.readDashboard())
            Route.StoredMeta -> stored(store.readMeta())
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
        data object StoredDashboard : Route
        data object StoredMeta : Route

        /** A bundled asset, relative to the APK assets root. */
        data class Asset(val path: String) : Route
    }

    companion object {
        const val HOST = ConfigParser.HOST
        const val STORED_DASHBOARD_PATH = "/stored/dashboard.json"
        const val STORED_META_PATH = "/stored/meta.json"
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
            return when (path) {
                "", "/" -> Route.Asset("index.html")
                STORED_DASHBOARD_PATH -> Route.StoredDashboard
                STORED_META_PATH -> Route.StoredMeta
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
