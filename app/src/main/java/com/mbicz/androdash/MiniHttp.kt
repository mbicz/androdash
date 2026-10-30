package com.mbicz.androdash

import java.io.InputStream

/**
 * Pure pieces of the [PhoneExporter]'s minimal HTTP/1.1 server (C-008): read a
 * bounded request head, parse the request line, route, and frame a
 * `Connection: close` response.
 */
object MiniHttp {
    /** Largest request head (request line plus headers) read, in bytes. */
    const val MAX_HEAD_BYTES = 8192
    const val OK = 200
    const val BAD_REQUEST = 400
    const val NOT_FOUND = 404
    const val METRICS_PATH = "/metrics"

    private val METHOD = Regex("^[A-Z]{1,16}$")
    private val VERSION = Regex("^HTTP/1\\.[01]$")

    data class RequestLine(val method: String, val target: String, val version: String) {
        /** [target] without its query string. */
        val path: String get() = target.substringBefore('?')
    }

    /**
     * Read the request head up to and excluding the blank line that ends it
     * (CRLF CRLF, or LF LF from lenient clients). Null when the stream ends
     * first or the head exceeds [limit] bytes.
     */
    fun readHead(input: InputStream, limit: Int = MAX_HEAD_BYTES): String? {
        val bytes = ByteArray(limit)
        var size = 0
        while (true) {
            val next = input.read()
            if (next < 0 || size == limit) return null
            bytes[size++] = next.toByte()
            if (endsHead(bytes, size)) {
                return String(bytes, 0, size, Charsets.ISO_8859_1).trimEnd('\r', '\n')
            }
        }
    }

    /** `METHOD SP target SP HTTP/1.x`; the target must be origin-form (`/…`). Null when malformed. */
    fun parseRequestLine(line: String): RequestLine? {
        val parts = line.split(' ')
        if (parts.size != 3) return null
        val (method, target, version) = parts
        if (!METHOD.matches(method) || !VERSION.matches(version)) return null
        if (!target.startsWith("/") || target.any { it <= ' ' || it.code >= 0x7f }) return null
        return RequestLine(method, target, version)
    }

    /** Request line of a [readHead] result: its first line without the line ending. */
    fun firstLine(head: String): String = head.substringBefore('\n').removeSuffix("\r")

    /** `GET /metrics` is [OK]; any other well-formed request [NOT_FOUND]; null [BAD_REQUEST]. */
    fun status(request: RequestLine?): Int = when {
        request == null -> BAD_REQUEST
        request.method == "GET" && request.path == METRICS_PATH -> OK
        else -> NOT_FOUND
    }

    fun reason(status: Int): String = when (status) {
        OK -> "OK"
        BAD_REQUEST -> "Bad Request"
        NOT_FOUND -> "Not Found"
        else -> "Error"
    }

    /** Full response bytes: status line, `Content-Type`, `Content-Length`, `Connection: close`, body. */
    fun response(status: Int, contentType: String, body: ByteArray): ByteArray {
        val head = "HTTP/1.1 $status ${reason(status)}\r\n" +
            "Content-Type: $contentType\r\n" +
            "Content-Length: ${body.size}\r\n" +
            "Connection: close\r\n" +
            "\r\n"
        return head.toByteArray(Charsets.ISO_8859_1) + body
    }

    private fun endsHead(bytes: ByteArray, size: Int): Boolean {
        val lf = '\n'.code.toByte()
        val cr = '\r'.code.toByte()
        if (size >= 2 && bytes[size - 1] == lf && bytes[size - 2] == lf) return true
        return size >= 4 && bytes[size - 1] == lf && bytes[size - 2] == cr &&
            bytes[size - 3] == lf && bytes[size - 4] == cr
    }
}
