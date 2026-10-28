package com.mbicz.androdash

import android.content.res.AssetManager
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.IOException

/**
 * Serves the trusted renderer from the virtual origin. No file:// access and no
 * directory traversal: only the explicit asset allowlist below is reachable.
 */
class AssetServer(private val assets: AssetManager) {
    fun intercept(request: WebResourceRequest): WebResourceResponse? {
        val uri = request.url
        if (!isLocal(uri)) return null
        if (request.method != "GET" && request.method != "HEAD") {
            return textResponse(405, "Method not allowed")
        }

        val path = uri.path.orEmpty()
        if (path.contains("..") || path.contains('\\') || path.contains('%') || path.contains("//")) {
            return textResponse(400, "Bad path")
        }
        val assetPath = when {
            path.isEmpty() || path == "/" -> "index.html"
            else -> path.removePrefix("/")
        }
        if (!ALLOWED.matches(assetPath)) {
            return textResponse(404, "Not found")
        }

        return try {
            val stream = assets.open(assetPath, AssetManager.ACCESS_STREAMING)
            val mime = mimeType(assetPath)
            val headers = mapOf(
                "Cache-Control" to "no-store",
                "X-Content-Type-Options" to "nosniff",
                "X-Frame-Options" to "DENY",
            )
            WebResourceResponse(mime, "utf-8", 200, "OK", headers, stream)
        } catch (_: IOException) {
            textResponse(404, "Not found")
        }
    }

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

    companion object {
        const val HOST = "androdash.local"
        private val ALLOWED = Regex(
            "^(index\\.html|styles\\.css|src/[A-Za-z0-9_./-]+\\.js)$",
        )

        fun isLocal(uri: Uri): Boolean =
            uri.scheme.equals("http", ignoreCase = true) &&
                uri.host.equals(HOST, ignoreCase = true) &&
                (uri.port == -1 || uri.port == 80)
    }
}
