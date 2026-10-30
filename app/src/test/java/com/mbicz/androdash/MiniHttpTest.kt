package com.mbicz.androdash

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream

class MiniHttpTest {
    private fun head(text: String, limit: Int = MiniHttp.MAX_HEAD_BYTES) =
        MiniHttp.readHead(ByteArrayInputStream(text.toByteArray(Charsets.ISO_8859_1)), limit)

    @Test
    fun `reads the head up to the blank line`() {
        val prometheus = "GET /metrics HTTP/1.1\r\nHost: 127.0.0.1:19100\r\n" +
            "Accept: text/plain;version=0.0.4\r\nX-Prometheus-Scrape-Timeout-Seconds: 10\r\n\r\nbody"
        val read = head(prometheus)!!
        assertEquals("GET /metrics HTTP/1.1", MiniHttp.firstLine(read))
        assertTrue(read.endsWith("X-Prometheus-Scrape-Timeout-Seconds: 10"))
        assertEquals("GET / HTTP/1.0", head("GET / HTTP/1.0\n\n"))
        assertEquals("GET /metrics HTTP/1.1", MiniHttp.firstLine(head("GET /metrics HTTP/1.1\r\n\r\n")!!))
    }

    @Test
    fun `incomplete or oversized heads are null`() {
        assertNull(head(""))
        assertNull(head("GET /metrics HTTP/1.1\r\n"))
        val line = "GET /${"a".repeat(MiniHttp.MAX_HEAD_BYTES)} HTTP/1.1\r\n\r\n"
        assertNull(head(line))
        val exact = "GET /metrics HTTP/1.1\r\n\r\n"
        assertEquals("GET /metrics HTTP/1.1", head(exact, exact.length))
        assertNull(head(exact, exact.length - 1))
    }

    @Test
    fun `request line parsing`() {
        assertEquals(
            MiniHttp.RequestLine("GET", "/metrics?x=1", "HTTP/1.1"),
            MiniHttp.parseRequestLine("GET /metrics?x=1 HTTP/1.1"),
        )
        assertEquals("/metrics", MiniHttp.parseRequestLine("GET /metrics?x=1 HTTP/1.1")!!.path)
        listOf(
            "",
            "GET",
            "GET /metrics",
            "GET  /metrics HTTP/1.1",
            "GET /metrics HTTP/1.1 extra",
            "get /metrics HTTP/1.1",
            "GET metrics HTTP/1.1",
            "GET http://127.0.0.1:19100/metrics HTTP/1.1",
            "GET /metrics HTTP/2.0",
            "GET /metrics HTTP/1.1\r",
            "GET /met\u0000rics HTTP/1.1",
            "GET /m\u00e9trics HTTP/1.1",
        ).forEach { assertNull(it, MiniHttp.parseRequestLine(it)) }
    }

    @Test
    fun `only GET metrics is served`() {
        fun status(line: String) = MiniHttp.status(MiniHttp.parseRequestLine(line))
        assertEquals(200, status("GET /metrics HTTP/1.1"))
        assertEquals(200, status("GET /metrics HTTP/1.0"))
        assertEquals(200, status("GET /metrics?name[]=up HTTP/1.1"))
        assertEquals(404, status("GET / HTTP/1.1"))
        assertEquals(404, status("GET /metrics/ HTTP/1.1"))
        assertEquals(404, status("GET /Metrics HTTP/1.1"))
        assertEquals(404, status("POST /metrics HTTP/1.1"))
        assertEquals(404, status("HEAD /metrics HTTP/1.1"))
        assertEquals(400, MiniHttp.status(null))
        assertEquals(400, status("garbage"))
    }

    @Test
    fun `responses close the connection and carry the length`() {
        val body = "a 1\n".toByteArray(Charsets.UTF_8)
        val text = String(MiniHttp.response(200, PhoneMetrics.CONTENT_TYPE, body), Charsets.ISO_8859_1)
        assertEquals(
            "HTTP/1.1 200 OK\r\n" +
                "Content-Type: text/plain; version=0.0.4; charset=utf-8\r\n" +
                "Content-Length: 4\r\n" +
                "Connection: close\r\n" +
                "\r\n" +
                "a 1\n",
            text,
        )
        val notFound = String(MiniHttp.response(404, "text/plain; charset=utf-8", ByteArray(0)), Charsets.ISO_8859_1)
        assertTrue(notFound.startsWith("HTTP/1.1 404 Not Found\r\n"))
        assertTrue(notFound.contains("Content-Length: 0\r\n"))
        assertEquals("Bad Request", MiniHttp.reason(400))
    }
}
