package com.mbicz.androdash

import android.content.Context
import android.util.Log
import java.io.BufferedInputStream
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket

/**
 * In-app Prometheus exporter for the phone itself (C-007 "Phone exporter",
 * C-008, decision 0021): a minimal HTTP/1.1 server on `127.0.0.1:19100` only,
 * one daemon thread serving one connection at a time. `GET /metrics` samples
 * the phone at scrape time ([PhoneSampler]) and returns [PhoneMetrics] text;
 * anything else is 404 (400 when malformed). Started and stopped by
 * [CollectorService] with the collector. Failures are logged, never thrown.
 */
class PhoneExporter(context: Context, collector: () -> CollectorRuntime) {
    private val sampler = PhoneSampler(context, collector)
    private val thread = Thread(::run, "androdash-phone-exporter").apply { isDaemon = true }

    @Volatile
    private var stopping = false

    @Volatile
    private var server: ServerSocket? = null

    fun start() {
        thread.start()
    }

    /** Close the listener and end the thread; returns without waiting for it. */
    fun stop() {
        stopping = true
        closeQuietly(server)
        thread.interrupt()
    }

    private fun run() {
        try {
            while (!stopping) {
                val socket = try {
                    bind()
                } catch (error: IOException) {
                    Log.w(TAG, "phone exporter bind failed: ${error.javaClass.simpleName}; retry in ${RETRY_MILLIS / 1000}s")
                    Thread.sleep(RETRY_MILLIS)
                    continue
                }
                server = socket
                if (stopping) {
                    closeQuietly(socket)
                    break
                }
                Log.i(TAG, "phone exporter listening on $HOST:${CollectorConfig.PHONE_PORT}")
                try {
                    while (!stopping) {
                        socket.accept().use(::serve)
                    }
                } catch (error: IOException) {
                    if (!stopping) Log.w(TAG, "phone exporter accept failed: ${error.javaClass.simpleName}")
                } finally {
                    closeQuietly(socket)
                }
                if (!stopping) Thread.sleep(RETRY_MILLIS)
            }
        } catch (_: InterruptedException) {
            // stop() requested.
        } catch (error: Exception) {
            Log.e(TAG, "phone exporter failed: ${error.javaClass.simpleName}")
        } finally {
            closeQuietly(server)
            Log.i(TAG, "phone exporter stopped")
        }
    }

    private fun bind(): ServerSocket = ServerSocket().apply {
        try {
            reuseAddress = true
            bind(InetSocketAddress(InetAddress.getByName(HOST), CollectorConfig.PHONE_PORT), BACKLOG)
        } catch (error: IOException) {
            closeQuietly(this)
            throw error
        }
    }

    /** One request, one response, then the connection closes. */
    private fun serve(socket: Socket) {
        try {
            socket.soTimeout = SOCKET_TIMEOUT_MILLIS
            val head = MiniHttp.readHead(BufferedInputStream(socket.getInputStream(), BUFFER_BYTES))
            val status = MiniHttp.status(head?.let { MiniHttp.parseRequestLine(MiniHttp.firstLine(it)) })
            val response = if (status == MiniHttp.OK) {
                MiniHttp.response(
                    status,
                    PhoneMetrics.CONTENT_TYPE,
                    PhoneMetrics.format(sampler.snapshot()).toByteArray(Charsets.UTF_8),
                )
            } else {
                MiniHttp.response(
                    status,
                    TEXT_PLAIN,
                    "${MiniHttp.reason(status)}\n".toByteArray(Charsets.UTF_8),
                )
            }
            socket.getOutputStream().apply {
                write(response)
                flush()
            }
        } catch (error: Exception) {
            Log.d(TAG, "phone exporter request failed: ${error.javaClass.simpleName}")
        }
    }

    private fun closeQuietly(socket: ServerSocket?) {
        try {
            socket?.close()
        } catch (_: IOException) {
            // Already closed.
        }
    }

    private companion object {
        const val TAG = "AndroDash"
        const val HOST = "127.0.0.1"
        const val BACKLOG = 8
        const val BUFFER_BYTES = 1024
        const val SOCKET_TIMEOUT_MILLIS = 5_000
        const val RETRY_MILLIS = 5_000L
        const val TEXT_PLAIN = "text/plain; charset=utf-8"
    }
}
