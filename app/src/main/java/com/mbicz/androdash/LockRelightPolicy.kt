package com.mbicz.androdash

/**
 * Pure power-button re-light decisions for `show_when_locked` (C-007, decision
 * 0016). MainActivity feeds it screen/unlock events with an explicit clock and
 * performs the returned action; this class holds no Android types so the
 * transitions are JVM-testable.
 *
 * States:
 * - [State.UNLOCKED]: normal use; the dashboard is in colour.
 * - [State.LOCKED_LIT]: the display is on (or being re-lit) over the keyguard,
 *   showing the dimmed grayscale dashboard.
 * - [State.LOCKED_DARK]: the user turned the display off while it was
 *   locked-lit; it stays off until the user wakes it.
 *
 * Only [onUnlocked] returns to [State.UNLOCKED], so a display that is re-lit
 * before the keyguard engages cannot re-light again on the next press.
 */
class LockRelightPolicy(private val relightWindowMillis: Long = RELIGHT_WINDOW_MILLIS) {
    enum class State { UNLOCKED, LOCKED_LIT, LOCKED_DARK }

    enum class OffAction {
        /** Re-light the display now; it will show the dashboard over the keyguard. */
        RELIGHT,

        /** Leave the display off. */
        STAY_OFF,
    }

    enum class OnCause {
        /** The display came on within the window of our own re-light. */
        RELIGHT,

        /** The user (or the system) woke the display. */
        WAKE,
    }

    var state: State = State.UNLOCKED
        private set

    private var relightAtMillis: Long? = null

    /**
     * The display turned off. Re-light only on the first press from normal use:
     * the dashboard must have been in the foreground (not another app) and the
     * keyguard must be engaged, so an unlocked or keyguard-less device is never
     * held awake. A press while locked-lit leaves the display off.
     */
    fun onScreenOff(
        nowMillis: Long,
        dashboardForeground: Boolean,
        keyguardLocked: Boolean,
    ): OffAction = when (state) {
        State.UNLOCKED -> if (dashboardForeground && keyguardLocked) {
            state = State.LOCKED_LIT
            relightAtMillis = nowMillis
            OffAction.RELIGHT
        } else {
            OffAction.STAY_OFF
        }
        State.LOCKED_LIT, State.LOCKED_DARK -> {
            state = State.LOCKED_DARK
            relightAtMillis = null
            OffAction.STAY_OFF
        }
    }

    /**
     * The display turned on. While the keyguard is up the display is
     * locked-lit, whether we re-lit it or the user woke it, so the next press
     * turns it off for real.
     */
    fun onScreenOn(nowMillis: Long, keyguardLocked: Boolean): OnCause {
        val requested = relightAtMillis
        relightAtMillis = null
        if (keyguardLocked) state = State.LOCKED_LIT
        return if (requested != null && nowMillis - requested in 0..relightWindowMillis) {
            OnCause.RELIGHT
        } else {
            OnCause.WAKE
        }
    }

    /** The user unlocked the device (ACTION_USER_PRESENT, or resumed while unlocked). */
    fun onUnlocked() {
        state = State.UNLOCKED
        relightAtMillis = null
    }

    companion object {
        /** Upper bound for the re-light wake lock and for attributing SCREEN_ON to it. */
        const val RELIGHT_WINDOW_MILLIS = 3_000L
    }
}
