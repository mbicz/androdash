package com.mbicz.androdash

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Foreground service that runs the bundled Prometheus (`libprometheus.so`) as a
 * child process on loopback (C-007 "Collector service", decision 0019). It
 * reads the persisted [AppConfig]; MainActivity saves the config before
 * starting it, and a sticky restart after a process kill reads it again.
 */
class CollectorService : Service() {
    private var supervisor: Supervisor? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val collector = try {
            ConfigStore(this).load()?.let { CollectorConfig.from(it) }
        } catch (_: ConfigException) {
            null
        }
        // startForegroundService() requires startForeground() even when stopping.
        startInForeground(collector?.targets?.size ?: 0)
        if (collector == null) {
            Log.w(TAG, "collector not configured; stopping service")
            stopSelf()
            return START_NOT_STICKY
        }
        val current = supervisor
        if (current == null || current.config != collector) {
            current?.shutdown()
            supervisor = Supervisor(collector, current).also { it.start() }
            Log.i(
                TAG,
                "collector starting: ${collector.targets.size} targets, scrape ${collector.scrapeSeconds}s, " +
                    "retention ${CollectorConfig.prometheusDuration(collector.retentionMillis)}",
            )
        }
        return START_STICKY
    }

    override fun onDestroy() {
        supervisor?.shutdown()
        supervisor = null
        Log.i(TAG, "collector service stopped")
        super.onDestroy()
    }

    private fun startInForeground(targetCount: Int) {
        val manager = getSystemService(NotificationManager::class.java)
        manager?.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                getString(R.string.collector_channel),
                NotificationManager.IMPORTANCE_LOW,
            ),
        )
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_collector)
            .setContentTitle(getString(R.string.collector_channel))
            .setContentText(
                resources.getQuantityString(R.plurals.collector_targets, targetCount, targetCount),
            )
            .setContentIntent(open)
            .setOngoing(true)
            .setShowWhen(false)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    /**
     * Runs and supervises one Prometheus configuration on its own thread. A
     * replacement waits for [previous] to finish so the port and TSDB lock are free.
     */
    private inner class Supervisor(
        val config: CollectorConfig,
        private val previous: Supervisor?,
    ) : Thread("androdash-collector") {
        @Volatile
        private var stopping = false
        private val policy = RestartPolicy()
        private var restarts = 0
        private var lastExit: String? = null

        fun shutdown() {
            stopping = true
            interrupt()
        }

        // Decision 0019: an always-plugged appliance; scrapes stop in doze without it.
        @SuppressLint("WakelockTimeout")
        override fun run() {
            val wakeLock = getSystemService(PowerManager::class.java)
                ?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG)
                ?.apply {
                    setReferenceCounted(false)
                    acquire()
                }
            var process: Process? = null
            try {
                awaitPrevious()
                val dir = File(filesDir, "collector").apply { mkdirs() }
                val configFile = File(dir, "prometheus.yml")
                val dataDir = File(dir, "data").apply { mkdirs() }
                val logFile = File(dir, "prometheus.log")
                writeAtomically(configFile, config.prometheusYaml())
                val arguments = config.arguments(
                    binary = File(applicationInfo.nativeLibraryDir, BINARY_NAME).absolutePath,
                    configFile = configFile.absolutePath,
                    dataDir = dataDir.absolutePath,
                )
                while (!stopping) {
                    if (logFile.length() > MAX_LOG_BYTES) logFile.delete()
                    val startedElapsed = SystemClock.elapsedRealtime()
                    policy.onStarted(startedElapsed)
                    try {
                        val started = ProcessBuilder(arguments)
                            .directory(dir)
                            .redirectErrorStream(true)
                            .redirectOutput(ProcessBuilder.Redirect.appendTo(logFile))
                            .start()
                        process = started
                        started.outputStream.close()
                        publish(running = true, startedAt = System.currentTimeMillis())
                        val code = started.waitFor()
                        process = null
                        val seconds = (SystemClock.elapsedRealtime() - startedElapsed) / 1000
                        lastExit = "exited with code $code after ${seconds}s"
                    } catch (error: IOException) {
                        lastExit = "start failed: ${error.javaClass.simpleName}"
                    }
                    if (stopping) break
                    val delay = policy.onExited(SystemClock.elapsedRealtime())
                    restarts++
                    publish(running = false, startedAt = null)
                    Log.w(TAG, "collector $lastExit; restart in ${delay / 1000}s")
                    sleep(delay)
                }
            } catch (_: InterruptedException) {
                // shutdown() requested.
            } catch (error: Exception) {
                lastExit = "supervisor failed: ${error.javaClass.simpleName}"
                Log.e(TAG, "collector $lastExit")
            } finally {
                process?.let(::terminate)
                publish(running = false, startedAt = null)
                if (wakeLock?.isHeld == true) wakeLock.release()
            }
        }

        /**
         * Wait for the replaced supervisor to stop its process (port, TSDB lock),
         * even when this one is shut down meanwhile; [stopping] then ends [run].
         */
        private fun awaitPrevious() {
            val old = previous ?: return
            while (old.isAlive) {
                try {
                    old.join()
                } catch (_: InterruptedException) {
                    // shutdown() set stopping; the loop in run() will not start.
                }
            }
        }

        private fun publish(running: Boolean, startedAt: Long?) {
            runtime = CollectorRuntime(running, restarts, startedAt, lastExit)
        }

        /** SIGTERM, then SIGKILL after [STOP_GRACE_SECONDS]. */
        private fun terminate(process: Process) {
            process.destroy()
            val exited = try {
                process.waitFor(STOP_GRACE_SECONDS, TimeUnit.SECONDS)
            } catch (_: InterruptedException) {
                false
            }
            if (!exited) {
                process.destroyForcibly()
                Log.w(TAG, "collector killed after ${STOP_GRACE_SECONDS}s")
            }
            lastExit = "stopped"
            Log.i(TAG, "collector process stopped")
        }
    }

    private fun writeAtomically(target: File, text: String) {
        val temp = File(target.parentFile, "${target.name}.tmp")
        temp.outputStream().use { stream ->
            stream.write(text.toByteArray(Charsets.UTF_8))
            stream.fd.sync()
        }
        if (!temp.renameTo(target)) throw IOException("rename failed")
    }

    companion object {
        private const val TAG = "AndroDash"
        private const val CHANNEL_ID = "collector"
        private const val NOTIFICATION_ID = 19090
        private const val WAKE_LOCK_TAG = "androdash:collector"
        private const val BINARY_NAME = "libprometheus.so"
        private const val MAX_LOG_BYTES = 1L shl 20
        private const val STOP_GRACE_SECONDS = 5L

        /** Latest supervisor state; read by the bridge (`collectorStatus`). */
        @Volatile
        var runtime: CollectorRuntime = CollectorRuntime()
            private set

        fun start(context: Context) {
            context.startForegroundService(Intent(context, CollectorService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CollectorService::class.java))
        }
    }
}
