package com.mbicz.androdash

import com.mbicz.androdash.LockRelightPolicy.OffAction
import com.mbicz.androdash.LockRelightPolicy.OnCause
import com.mbicz.androdash.LockRelightPolicy.State
import org.junit.Assert.assertEquals
import org.junit.Test

class LockRelightPolicyTest {
    private val policy = LockRelightPolicy()

    @Test
    fun `first power press from normal use re-lights the display`() {
        assertEquals(State.UNLOCKED, policy.state)
        assertEquals(OffAction.RELIGHT, policy.onScreenOff(1_000, dashboardForeground = true, keyguardLocked = true))
        assertEquals(State.LOCKED_LIT, policy.state)
        assertEquals(OnCause.RELIGHT, policy.onScreenOn(1_400, keyguardLocked = true))
        assertEquals(State.LOCKED_LIT, policy.state)
    }

    @Test
    fun `second power press while locked-lit leaves the display off`() {
        policy.onScreenOff(1_000, dashboardForeground = true, keyguardLocked = true)
        policy.onScreenOn(1_300, keyguardLocked = true)

        assertEquals(OffAction.STAY_OFF, policy.onScreenOff(5_000, dashboardForeground = true, keyguardLocked = true))
        assertEquals(State.LOCKED_DARK, policy.state)
    }

    @Test
    fun `second press before the re-light lands still stays off`() {
        policy.onScreenOff(1_000, dashboardForeground = true, keyguardLocked = true)

        assertEquals(OffAction.STAY_OFF, policy.onScreenOff(1_200, dashboardForeground = true, keyguardLocked = true))
        assertEquals(State.LOCKED_DARK, policy.state)
    }

    @Test
    fun `manual wake after locked-dark returns to locked-lit`() {
        policy.onScreenOff(1_000, dashboardForeground = true, keyguardLocked = true)
        policy.onScreenOn(1_300, keyguardLocked = true)
        policy.onScreenOff(5_000, dashboardForeground = true, keyguardLocked = true)

        assertEquals(OnCause.WAKE, policy.onScreenOn(60_000, keyguardLocked = true))
        assertEquals(State.LOCKED_LIT, policy.state)
        assertEquals(OffAction.STAY_OFF, policy.onScreenOff(70_000, dashboardForeground = true, keyguardLocked = true))
        assertEquals(State.LOCKED_DARK, policy.state)
    }

    @Test
    fun `screen on long after a lost re-light counts as a manual wake`() {
        policy.onScreenOff(1_000, dashboardForeground = true, keyguardLocked = true)

        assertEquals(
            OnCause.WAKE,
            policy.onScreenOn(1_000 + LockRelightPolicy.RELIGHT_WINDOW_MILLIS + 1, keyguardLocked = true),
        )
        assertEquals(State.LOCKED_LIT, policy.state)
    }

    @Test
    fun `unlock resets so the next press re-lights again`() {
        policy.onScreenOff(1_000, dashboardForeground = true, keyguardLocked = true)
        policy.onScreenOn(1_300, keyguardLocked = true)
        policy.onScreenOff(5_000, dashboardForeground = true, keyguardLocked = true)
        policy.onScreenOn(9_000, keyguardLocked = true)

        policy.onUnlocked()
        assertEquals(State.UNLOCKED, policy.state)
        assertEquals(OffAction.RELIGHT, policy.onScreenOff(20_000, dashboardForeground = true, keyguardLocked = true))
        assertEquals(State.LOCKED_LIT, policy.state)
    }

    @Test
    fun `no re-light when another app is in the foreground`() {
        assertEquals(OffAction.STAY_OFF, policy.onScreenOff(1_000, dashboardForeground = false, keyguardLocked = true))
        assertEquals(State.UNLOCKED, policy.state)
    }

    @Test
    fun `no re-light when the keyguard is not engaged`() {
        assertEquals(OffAction.STAY_OFF, policy.onScreenOff(1_000, dashboardForeground = true, keyguardLocked = false))
        assertEquals(State.UNLOCKED, policy.state)
        assertEquals(OnCause.WAKE, policy.onScreenOn(2_000, keyguardLocked = false))
        assertEquals(State.UNLOCKED, policy.state)
    }

    @Test
    fun `waking onto the keyguard after a missed re-light is locked-lit`() {
        policy.onScreenOff(1_000, dashboardForeground = true, keyguardLocked = false)
        policy.onScreenOn(30_000, keyguardLocked = true)

        assertEquals(State.LOCKED_LIT, policy.state)
        assertEquals(OffAction.STAY_OFF, policy.onScreenOff(40_000, dashboardForeground = true, keyguardLocked = true))
    }
}
