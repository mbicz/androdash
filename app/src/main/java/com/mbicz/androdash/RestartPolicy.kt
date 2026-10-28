package com.mbicz.androdash

/**
 * Collector restart backoff (C-007, decision 0019): after each exit wait
 * 1, 2, 4, … seconds, capped at 60 s. A process that ran for at least
 * [healthyResetMillis] before exiting counts as healthy and restarts the
 * sequence at 1 s. Pure; callers pass a monotonic clock.
 */
class RestartPolicy(
    private val initialDelayMillis: Long = 1_000L,
    private val maxDelayMillis: Long = 60_000L,
    private val healthyResetMillis: Long = 600_000L,
) {
    /** Exits since the last healthy run; drives the next delay. */
    var consecutiveFailures: Int = 0
        private set

    private var startedAtMillis: Long? = null

    fun onStarted(nowMillis: Long) {
        startedAtMillis = nowMillis
    }

    /** Record an exit (or a failed start) and return the delay before the next start. */
    fun onExited(nowMillis: Long): Long {
        val started = startedAtMillis
        startedAtMillis = null
        if (started != null && nowMillis - started >= healthyResetMillis) {
            consecutiveFailures = 0
        }
        val delay = delayFor(consecutiveFailures)
        consecutiveFailures++
        return delay
    }

    private fun delayFor(failures: Int): Long {
        var delay = initialDelayMillis
        repeat(failures) {
            if (delay >= maxDelayMillis) return maxDelayMillis
            delay *= 2
        }
        return minOf(delay, maxDelayMillis)
    }
}
