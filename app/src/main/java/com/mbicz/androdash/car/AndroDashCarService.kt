package com.mbicz.androdash.car

import android.content.Intent
import androidx.car.app.CarAppService
import androidx.car.app.Session
import androidx.car.app.validation.HostValidator

/**
 * Android Auto entry point (C-010). The app declares the `IOT` category in its
 * manifest, so CAL hands over templates only — never a drawing surface.
 */
class AndroDashCarService : CarAppService() {
    override fun createHostValidator(): HostValidator = HostValidator.ALLOW_ALL_HOSTS_VALIDATOR

    override fun onCreateSession(): Session = AndroDashCarSession()
}

class AndroDashCarSession : Session() {
    override fun onCreateScreen(intent: Intent) = AndroDashCarScreen(carContext)
}
