package com.mbicz.androdash

import org.junit.Assert.assertEquals
import org.junit.Test

class RestartPolicyTest {
    @Test
    fun `backoff doubles from 1 s and caps at 60 s`() {
        val policy = RestartPolicy()
        var now = 0L
        val delays = (1..9).map {
            policy.onStarted(now)
            now += 2_000L
            policy.onExited(now).also { delay -> now += delay }
        }
        assertEquals(
            listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 32_000L, 60_000L, 60_000L, 60_000L),
            delays,
        )
        assertEquals(9, policy.consecutiveFailures)
    }

    @Test
    fun `a run of 10 minutes resets the backoff`() {
        val policy = RestartPolicy()
        repeat(4) {
            policy.onStarted(0L)
            policy.onExited(1_000L)
        }
        policy.onStarted(100_000L)
        assertEquals(1_000L, policy.onExited(100_000L + 600_000L))
        assertEquals(1, policy.consecutiveFailures)
    }

    @Test
    fun `a run just under 10 minutes keeps backing off`() {
        val policy = RestartPolicy()
        policy.onStarted(0L)
        assertEquals(1_000L, policy.onExited(1L))
        policy.onStarted(10L)
        assertEquals(2_000L, policy.onExited(10L + 599_999L))
    }

    @Test
    fun `an exit without a recorded start still backs off`() {
        val policy = RestartPolicy()
        assertEquals(1_000L, policy.onExited(5L))
        assertEquals(2_000L, policy.onExited(6L))
    }

    @Test
    fun `many failures never overflow the cap`() {
        val policy = RestartPolicy()
        repeat(1_000) { policy.onExited(it.toLong()) }
        assertEquals(60_000L, policy.onExited(2_000L))
    }
}
