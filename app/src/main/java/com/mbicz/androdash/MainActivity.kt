package com.mbicz.androdash

import android.app.Activity
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI

class MainActivity : Activity() {
    private lateinit var configStore: ConfigStore
    private lateinit var assetServer: AssetServer
    private lateinit var dashboardStore: DashboardStore
    private lateinit var inlineDashboards: InlineDashboards

    /** Current canonical config; read by the bridge thread (`setOption`, `storeDashboard`, `addInlineDashboard`). */
    @Volatile
    private var config: AppConfig? = null
    private var rendererUrl: String? = null
    private var webView: WebView? = null

    /** True while the fatal screen is shown; read by the bridge thread. */
    @Volatile
    private var fatal = false

    /** Effective `show_when_locked` (C-007); read by the bridge thread. */
    @Volatile
    private var showWhenLocked = false
    private var lockReceiver: BroadcastReceiver? = null
    private val relightPolicy = LockRelightPolicy()
    private var relightWakeLock: PowerManager.WakeLock? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val relightCheck = Runnable { decideRelight() }

    /** False once the user leaves the dashboard for another app while the display is on. */
    private var dashboardForeground = false
    private var lockedDim = false

    /** True while an ignition document is being fetched/parsed off the UI thread. */
    private var ignitionPending = false

    /** The API 33+ kiosk back consumer (an `OnBackInvokedCallback`) while registered. */
    private var backCallback: Any? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        configStore = ConfigStore(this)
        dashboardStore = DashboardStore(filesDir)
        dashboardStore.removeLegacy()
        inlineDashboards = InlineDashboards(filesDir)
        assetServer = AssetServer(assets, dashboardStore, inlineDashboards)
        applyIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        applyIntent(intent)
    }

    /**
     * Parse and apply a launch. An `ignition_url` extra (or, without it, a
     * `<filesDir>/ignition.json`) seeds the config from one document instead of
     * the extras; that document is fetched/applied off the UI thread and the
     * source is consumed once it succeeds. Otherwise a new intent without launch
     * extras (launcher tap, SystemUI re-start) or one that resolves to the
     * renderer URL already loaded keeps the live WebView (C-007); only the
     * native postures are re-applied. A changed `dashboard_urls` prunes
     * unreferenced inline dashboards.
     */
    private fun applyIntent(intent: Intent?) {
        val extras = readExtras(intent)
        val ignitionUrl = extras[IGNITION_EXTRA]?.trim().orEmpty()
        if (ignitionPending) {
            Log.i(TAG, "ignition already pending; intent ignored")
            return
        }
        if (ignitionUrl.isNotEmpty()) {
            applyIgnition(ignitionUrl = ignitionUrl, file = null)
            return
        }
        val file = File(filesDir, IGNITION_FILE)
        if (file.isFile) {
            applyIgnition(ignitionUrl = null, file = file)
            return
        }
        applyParsed(extras)
    }

    private fun consumeIgnitionExtra(intent: Intent?) {
        val target = intent ?: return
        target.removeExtra(IGNITION_EXTRA)
        setIntent(target)
    }

    /**
     * Ignition (C-009): fetch/read the document on a background thread while
     * the app background is shown, then apply it on the UI thread. A rejected
     * document shows `E_IGNITION`; a failed `ignition_url` fetch shows
     * `E_IGNITION_FETCH`. Nothing is persisted on failure and the file source
     * stays in place.
     */
    private fun applyIgnition(ignitionUrl: String?, file: File?) {
        ignitionPending = true
        showBackground()
        Thread({
            val document = try {
                val text = if (ignitionUrl != null) fetchIgnition(ignitionUrl) else readIgnitionFile(file!!)
                Ignition.parse(text)
            } catch (error: ConfigException) {
                Log.w(TAG, "ignition rejected: ${error.message}")
                mainHandler.post {
                    ignitionPending = false
                    if (isFinishing || isDestroyed) return@post
                    showFatal(error.code, error.message.orEmpty())
                }
                return@Thread
            }
            mainHandler.post {
                if (isFinishing || isDestroyed) {
                    ignitionPending = false
                    return@post
                }
                applyIgnitionDocument(document, file)
            }
        }, "ignition").start()
    }

    /** Store the document's inline dashboards, merge it over the persisted config, and apply it. */
    private fun applyIgnitionDocument(document: IgnitionDocument, file: File?) {
        ignitionPending = false
        val persisted = configStore.load()
        try {
            val referenced = ArrayList<String>(persisted?.dashboardUrls.orEmpty())
            document.dashboardUrls?.let { referenced.addAll(it) }
            val inlineUrls = ArrayList<String>()
            for (json in document.inlineDashboards) {
                inlineUrls.add(inlineDashboards.write(json, referenced + inlineUrls))
            }
            val merged = Ignition.merge(persisted, document.withInlineUrls(inlineUrls))
            config = merged
            rendererUrl = ConfigParser.launchUrl(merged)
            configStore.save(merged)
            pruneInline(merged)
            // One-shot: neither source may seed again over later in-app edits.
            if (file != null && !file.delete()) Log.w(TAG, "ignition file could not be removed")
            consumeIgnitionExtra(getIntent())
            logConfig(merged, emptyList())
            Log.i(
                TAG,
                "ignition applied: ${merged.dashboardUrls.size} dashboards, ${inlineUrls.size} inline, " +
                    "collector=${if (merged.collector) "on" else "off"}, " +
                    "${CollectorConfig.configuredTargets(merged).size} targets",
            )
            syncCollector(merged)
            fatal = false
            setupWebView()
            applyKiosk(merged)
            applyShowWhenLocked(merged.kiosk && configStore.loadShowWhenLocked())
        } catch (error: ConfigException) {
            Log.w(TAG, "ignition rejected: ${error.message}")
            // Undo any inline files written for this document; keep persisted ones.
            runCatching { inlineDashboards.prune(persisted?.dashboardUrls.orEmpty()) }
            showFatal(error.code, error.message.orEmpty())
        } catch (error: Exception) {
            val reason = error.message ?: error.javaClass.simpleName
            Log.w(TAG, "ignition rejected: $reason")
            runCatching { inlineDashboards.prune(persisted?.dashboardUrls.orEmpty()) }
            showFatal(Ignition.CODE_INVALID, sanitize(reason, MAX_ERROR))
        }
    }

    /** Read `<filesDir>/ignition.json`, bounded by [Ignition.MAX_BYTES]. */
    private fun readIgnitionFile(file: File): String {
        if (file.length() > Ignition.MAX_BYTES) {
            throw ConfigException(Ignition.CODE_INVALID, "ignition exceeds ${Ignition.MAX_BYTES} bytes")
        }
        val bytes = try {
            file.readBytes()
        } catch (_: IOException) {
            throw ConfigException(Ignition.CODE_INVALID, "ignition file could not be read")
        }
        if (bytes.size > Ignition.MAX_BYTES) {
            throw ConfigException(Ignition.CODE_INVALID, "ignition exceeds ${Ignition.MAX_BYTES} bytes")
        }
        return String(bytes, Charsets.UTF_8)
    }

    /**
     * Fetch `ignition_url`: http(s) only, 10 s connect/read timeout, at most
     * [Ignition.MAX_BYTES] bytes (declared or streamed), 2xx only. Every failure
     * is `E_IGNITION_FETCH`.
     */
    private fun fetchIgnition(raw: String): String {
        val url = try {
            ConfigParser.validateHttpUrl(raw, "ignition_url")
        } catch (error: ConfigException) {
            throw ConfigException(Ignition.CODE_FETCH, error.message ?: "ignition_url must be an http(s) URL")
        }
        val connection = try {
            (URI(url).toURL().openConnection() as HttpURLConnection).apply {
                connectTimeout = IGNITION_TIMEOUT_MILLIS
                readTimeout = IGNITION_TIMEOUT_MILLIS
                instanceFollowRedirects = false
                requestMethod = "GET"
                setRequestProperty("Accept", "application/json")
            }
        } catch (_: Exception) {
            throw ConfigException(Ignition.CODE_FETCH, "ignition_url could not be opened")
        }
        try {
            val status = connection.responseCode
            if (status !in 200..299) {
                throw ConfigException(Ignition.CODE_FETCH, "ignition_url returned HTTP $status")
            }
            if (connection.contentLengthLong > Ignition.MAX_BYTES) {
                throw ConfigException(Ignition.CODE_FETCH, "ignition_url exceeds ${Ignition.MAX_BYTES} bytes")
            }
            val out = ByteArrayOutputStream()
            connection.inputStream.use { input ->
                val buffer = ByteArray(16 * 1024)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    out.write(buffer, 0, count)
                    if (out.size() > Ignition.MAX_BYTES) {
                        throw ConfigException(Ignition.CODE_FETCH, "ignition_url exceeds ${Ignition.MAX_BYTES} bytes")
                    }
                }
            }
            return out.toString("UTF-8")
        } catch (error: ConfigException) {
            throw error
        } catch (_: Exception) {
            throw ConfigException(Ignition.CODE_FETCH, "ignition_url could not be read")
        } finally {
            connection.disconnect()
        }
    }

    /** The plain background shown while an ignition document is fetched. */
    private fun showBackground() {
        webView?.let { old ->
            (old.parent as? ViewGroup)?.removeView(old)
            old.removeJavascriptInterface(BRIDGE_NAME)
            old.destroy()
        }
        webView = null
        setContentView(
            FrameLayout(this).apply { setBackgroundColor(displayBackground()) },
        )
    }

    private fun applyParsed(extras: Map<String, String?>) {
        val persisted = configStore.load()
        try {
            val parsed = ConfigParser.parse(extras, persisted, configStore.loadShowWhenLocked())
            val nextUrl = ConfigParser.launchUrl(parsed.config)
            val liveUrl = if (fatal || webView == null) null else rendererUrl
            val keep = ConfigParser.keepsRenderer(extras, liveUrl, nextUrl)
            config = parsed.config
            rendererUrl = nextUrl
            configStore.save(parsed.config)
            if (persisted?.dashboardUrls != parsed.config.dashboardUrls) pruneInline(parsed.config)
            configStore.saveShowWhenLocked(parsed.showWhenLockedPreference)
            logConfig(parsed.config, parsed.warnings)
            syncCollector(parsed.config)
            if (keep) {
                Log.i(TAG, "intent without changes; keeping renderer")
            } else {
                fatal = false
                setupWebView()
            }
            applyKiosk(parsed.config)
            applyShowWhenLocked(parsed.showWhenLocked)
            if (parsed.lockTask) attemptLockTask()
        } catch (error: ConfigException) {
            Log.w(TAG, "Configuration rejected: ${error.code}")
            showFatal(error.code, error.message.orEmpty())
        }
    }

    private fun readExtras(intent: Intent?): Map<String, String?> {
        val bundle = intent?.extras ?: return emptyMap()
        val values = LinkedHashMap<String, String?>()
        for (key in bundle.keySet()) {
            values[key] = bundle.get(key)?.toString()
        }
        return values
    }

    /**
     * C-007 collector lifecycle: start (or reconfigure) the foreground service
     * before the renderer loads when `collector=true`; stop it otherwise.
     */
    private fun syncCollector(config: AppConfig) {
        if (!config.collector) {
            CollectorService.stop(this)
            return
        }
        try {
            CollectorService.start(this)
            Log.i(TAG, "collector service requested")
        } catch (error: Exception) {
            Log.w(TAG, "collector start refused: ${error.javaClass.simpleName}")
        }
    }

    /** Drop inline dashboards [config] no longer lists in `dashboard_urls` (C-007). */
    private fun pruneInline(config: AppConfig) {
        try {
            val removed = inlineDashboards.prune(config.dashboardUrls)
            if (removed > 0) Log.i(TAG, "inline dashboards pruned: $removed")
        } catch (error: Exception) {
            Log.w(TAG, "inline prune failed: ${error.javaClass.simpleName}")
        }
    }

    private fun setupWebView() {
        val url = rendererUrl ?: return
        webView?.let { old ->
            (old.parent as? ViewGroup)?.removeView(old)
            old.removeJavascriptInterface(BRIDGE_NAME)
            old.destroy()
        }

        val web = WebView(this)
        web.setBackgroundColor(displayBackground())
        web.isVerticalScrollBarEnabled = false
        web.isHorizontalScrollBarEnabled = false
        web.overScrollMode = View.OVER_SCROLL_NEVER

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = false
            databaseEnabled = false
            setGeolocationEnabled(false)
            mediaPlaybackRequiresUserGesture = true
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            cacheMode = WebSettings.LOAD_DEFAULT
            textZoom = 100
            setSafeBrowsingEnabled(true)
        }

        CookieManager.getInstance().apply {
            setAcceptCookie(false)
            setAcceptThirdPartyCookies(web, false)
        }

        web.addJavascriptInterface(Bridge(), BRIDGE_NAME)
        web.webViewClient = createWebViewClient()
        web.webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(
                view: WebView?,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: android.os.Message?,
            ): Boolean = false

            override fun onPermissionRequest(request: PermissionRequest?) {
                request?.deny()
            }

            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: android.webkit.ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?,
            ): Boolean = false

            override fun onConsoleMessage(message: android.webkit.ConsoleMessage?): Boolean {
                message?.let {
                    Log.d(TAG, "web: ${sanitize(it.message(), 240)}")
                }
                return true
            }
        }
        web.setDownloadListener { _, _, _, _, _ ->
            Log.w(TAG, "Blocked download")
        }

        webView = web
        val root = FrameLayout(this).apply {
            setBackgroundColor(displayBackground())
            addView(
                web,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
            )
        }
        setContentView(root)
        web.loadUrl(url)
        Log.i(TAG, "renderer loaded")
    }

    private fun createWebViewClient(): WebViewClient = object : WebViewClient() {
        override fun shouldInterceptRequest(
            view: WebView?,
            request: WebResourceRequest?,
        ): WebResourceResponse? {
            if (request == null) return null
            return assetServer.intercept(request)
        }

        override fun shouldOverrideUrlLoading(
            view: WebView?,
            request: WebResourceRequest?,
        ): Boolean {
            val uri = request?.url ?: return true
            if (AssetServer.isLocal(uri)) return false
            Log.w(TAG, "Blocked navigation to ${redactUrl(uri.toString())}")
            return true
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            if (url != null && AssetServer.isLocal(Uri.parse(url))) {
                Log.i(TAG, "renderer ready")
                // A cold start (or reload) on the lock screen must start grayscale.
                if (view === webView && showWhenLocked) showLocked(isKeyguardLocked())
            }
        }

        override fun onReceivedError(
            view: WebView?,
            request: WebResourceRequest?,
            error: WebResourceError?,
        ) {
            val uri = request?.url ?: return
            if (request.isForMainFrame && AssetServer.isLocal(uri)) {
                Log.e(TAG, "local asset load failed: ${error?.errorCode}")
                showFatal("E_ASSET_LOAD", "The bundled renderer could not be loaded")
            }
        }

        override fun onReceivedHttpError(
            view: WebView?,
            request: WebResourceRequest?,
            errorResponse: WebResourceResponse?,
        ) {
            val uri = request?.url ?: return
            if (request.isForMainFrame && AssetServer.isLocal(uri)) {
                Log.e(TAG, "local asset HTTP error: ${errorResponse?.statusCode}")
                showFatal("E_ASSET_LOAD", "The bundled renderer returned HTTP ${errorResponse?.statusCode}")
            }
        }

        override fun onRenderProcessGone(
            view: WebView?,
            detail: RenderProcessGoneDetail?,
        ): Boolean {
            Log.e(TAG, "renderer process gone (crashed=${detail?.didCrash()})")
            val gone = view ?: return true
            if (gone !== webView) return true
            (gone.parent as? ViewGroup)?.removeView(gone)
            gone.removeJavascriptInterface(BRIDGE_NAME)
            gone.destroy()
            webView = null
            if (!fatal) {
                runOnUiThread { setupWebView() }
            }
            return true
        }
    }

    private fun applyKiosk(config: AppConfig) {
        enterImmersive()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
        applyBackCallback(config.kiosk)
        if (config.kiosk) {
            Log.i(TAG, "kiosk enabled")
        }
    }

    /**
     * C-007 back handling on API 33+ (`enableOnBackInvokedCallback`): while
     * kiosk is on, a default-priority callback consumes Back, so no predictive
     * back animation reveals the launcher. Older releases use [onBackPressed].
     */
    private fun applyBackCallback(kiosk: Boolean) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val dispatcher = onBackInvokedDispatcher
        val registered = backCallback as OnBackInvokedCallback?
        if (kiosk && registered == null) {
            val callback = OnBackInvokedCallback { Log.i(TAG, "back ignored in kiosk") }
            dispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback)
            backCallback = callback
        } else if (!kiosk && registered != null) {
            dispatcher.unregisterOnBackInvokedCallback(registered)
            backCallback = null
        }
    }

    /**
     * C-007 lock-screen display. This does not dismiss or bypass the keyguard;
     * it only keeps the activity visible above it while the device is locked,
     * dims and grays it there (decision 0016), and re-lights the display once
     * after the first power press.
     */
    private fun applyShowWhenLocked(enabled: Boolean) {
        val wasEnabled = showWhenLocked
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                setShowWhenLocked(enabled)
                setTurnScreenOn(enabled)
            } else {
                @Suppress("DEPRECATION")
                if (enabled) {
                    window.addFlags(
                        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
                    )
                } else {
                    window.clearFlags(
                        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
                    )
                }
            }
        } catch (error: Exception) {
            Log.w(TAG, "lock-screen display unavailable: ${error.javaClass.simpleName}")
            if (enabled) return
        }
        showWhenLocked = enabled
        if (enabled) {
            registerLockReceiver()
            showLocked(isKeyguardLocked())
            Log.i(TAG, "show over lock screen enabled")
        } else {
            mainHandler.removeCallbacks(relightCheck)
            unregisterLockReceiver()
            releaseRelight()
            relightPolicy.onUnlocked()
            if (wasEnabled) {
                showLocked(false)
                Log.i(TAG, "show over lock screen disabled")
            }
        }
    }

    private fun isKeyguardLocked(): Boolean =
        getSystemService(KeyguardManager::class.java)?.isKeyguardLocked == true

    /**
     * Dim the window and tell the renderer it is on the lock screen (grayscale),
     * or restore system brightness and colour. The scripts are fixed constants
     * (C-008); no input reaches evaluateJavascript.
     */
    private fun showLocked(locked: Boolean) {
        if (lockedDim != locked) {
            lockedDim = locked
            window.attributes = window.attributes.apply {
                screenBrightness = if (locked) {
                    LOCKED_BRIGHTNESS
                } else {
                    WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
                }
            }
        }
        webView?.evaluateJavascript(if (locked) JS_SET_LOCKED_TRUE else JS_SET_LOCKED_FALSE, null)
    }

    private fun registerLockReceiver() {
        if (lockReceiver != null) return
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                when (intent?.action) {
                    Intent.ACTION_SCREEN_OFF -> onScreenOff()
                    Intent.ACTION_SCREEN_ON -> onScreenOn()
                    Intent.ACTION_USER_PRESENT -> onUserPresent()
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        // Protected system broadcasts only, so no exported/not-exported flag applies.
        registerReceiver(receiver, filter)
        lockReceiver = receiver
    }

    private fun unregisterLockReceiver() {
        val receiver = lockReceiver ?: return
        lockReceiver = null
        try {
            unregisterReceiver(receiver)
        } catch (_: IllegalArgumentException) {
            // Already unregistered.
        }
    }

    /**
     * Defer the decision briefly so the keyguard has engaged after the press
     * (it can lock as the display finishes turning off).
     */
    private fun onScreenOff() {
        mainHandler.removeCallbacks(relightCheck)
        mainHandler.postDelayed(relightCheck, RELIGHT_SETTLE_MILLIS)
    }

    private fun decideRelight() {
        if (!showWhenLocked) return
        val power = getSystemService(PowerManager::class.java) ?: return
        if (power.isInteractive) return
        val locked = isKeyguardLocked()
        val action = relightPolicy.onScreenOff(
            nowMillis = SystemClock.elapsedRealtime(),
            dashboardForeground = dashboardForeground,
            keyguardLocked = locked,
        )
        when (action) {
            LockRelightPolicy.OffAction.RELIGHT -> relight(power)
            LockRelightPolicy.OffAction.STAY_OFF -> Log.i(TAG, "display left off (${relightPolicy.state})")
        }
    }

    private fun relight(power: PowerManager) {
        // Present the dimmed grayscale view before the display comes back.
        showLocked(true)
        try {
            @Suppress("DEPRECATION")
            val lock = relightWakeLock ?: power.newWakeLock(
                PowerManager.SCREEN_DIM_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
                RELIGHT_WAKE_LOCK_TAG,
            ).also {
                it.setReferenceCounted(false)
                relightWakeLock = it
            }
            lock.acquire(LockRelightPolicy.RELIGHT_WINDOW_MILLIS)
            Log.i(TAG, "display re-lit over lock screen")
        } catch (error: Exception) {
            Log.w(TAG, "display re-light failed: ${error.javaClass.simpleName}")
        }
    }

    private fun releaseRelight() {
        val lock = relightWakeLock ?: return
        try {
            if (lock.isHeld) lock.release()
        } catch (_: RuntimeException) {
            // Timed out between isHeld and release.
        }
    }

    private fun onScreenOn() {
        mainHandler.removeCallbacks(relightCheck)
        if (!showWhenLocked) return
        val locked = isKeyguardLocked()
        val cause = relightPolicy.onScreenOn(SystemClock.elapsedRealtime(), locked)
        if (locked) showLocked(true)
        Log.i(TAG, "display on ($cause, ${relightPolicy.state})")
    }

    private fun onUserPresent() {
        mainHandler.removeCallbacks(relightCheck)
        if (!showWhenLocked) return
        relightPolicy.onUnlocked()
        releaseRelight()
        showLocked(false)
    }

    private fun displayBackground(): Int =
        if (config?.displayMode == "amoled" || config?.displayMode == "monochrome") {
            Color.BLACK
        } else {
            BACKGROUND
        }

    private fun enterImmersive() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.apply {
                hide(WindowInsets.Type.systemBars())
                systemBarsBehavior =
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                    View.SYSTEM_UI_FLAG_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                )
        }
    }

    private fun attemptLockTask() {
        if (config?.kiosk != true) return
        try {
            startLockTask()
            Log.i(TAG, "lock task requested")
        } catch (error: Exception) {
            Log.w(TAG, "lock task unavailable: ${error.javaClass.simpleName}")
        }
    }

    @Deprecated("Deprecated in API 33; kept for pre-33 devices.")
    override fun onBackPressed() {
        if (config?.kiosk == true) {
            Log.i(TAG, "back ignored in kiosk")
            return
        }
        super.onBackPressed()
    }

    override fun onStart() {
        super.onStart()
        dashboardForeground = true
    }

    override fun onResume() {
        super.onResume()
        webView?.onResume()
        enterImmersive()
        if (showWhenLocked) {
            val locked = isKeyguardLocked()
            if (!locked) relightPolicy.onUnlocked()
            showLocked(locked)
        }
    }

    override fun onPause() {
        webView?.onPause()
        super.onPause()
    }

    override fun onStop() {
        // Stopped by the display turning off: still the dashboard. Stopped with
        // the display on: the user left for another app; do not re-light for it.
        if (getSystemService(PowerManager::class.java)?.isInteractive != false) {
            dashboardForeground = false
        }
        super.onStop()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus) return
        enterImmersive()
        if (showWhenLocked && isKeyguardLocked()) showLocked(true)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        rendererUrl?.let { outState.putString(STATE_URL, it) }
    }

    override fun onDestroy() {
        mainHandler.removeCallbacks(relightCheck)
        unregisterLockReceiver()
        releaseRelight()
        if (isFinishing) {
            webView?.let { web ->
                web.removeJavascriptInterface(BRIDGE_NAME)
                (web.parent as? ViewGroup)?.removeView(web)
                web.loadUrl("about:blank")
                web.destroy()
            }
            webView = null
        }
        super.onDestroy()
    }

    private fun showFatal(code: String, reason: String) {
        fatal = true
        // No dashboard, nothing to show over the keyguard.
        applyShowWhenLocked(false)
        webView?.let { web ->
            web.removeJavascriptInterface(BRIDGE_NAME)
            (web.parent as? ViewGroup)?.removeView(web)
            web.destroy()
        }
        webView = null

        val scroll = ScrollView(this).apply {
            setBackgroundColor(displayBackground())
            isFillViewport = true
        }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(28), dp(48), dp(28), dp(48))
        }
        val title = TextView(this).apply {
            text = "AndroDash"
            setTextColor(ACCENT)
            textSize = 14f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            letterSpacing = 0.08f
        }
        val heading = TextView(this).apply {
            text = "Cannot start"
            setTextColor(TEXT)
            textSize = 28f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setPadding(0, dp(10), 0, dp(4))
        }
        val codeView = TextView(this).apply {
            text = code
            setTextColor(CRITICAL)
            textSize = 12f
            typeface = Typeface.MONOSPACE
            setPadding(0, dp(6), 0, dp(8))
        }
        val reasonView = TextView(this).apply {
            text = sanitize(reason, 500)
            setTextColor(MUTED)
            textSize = 14f
            setLineSpacing(dp(2).toFloat(), 1f)
        }
        val commandView = TextView(this).apply {
            text = COMMAND_SHAPE
            setTextColor(ACCENT)
            textSize = 11f
            typeface = Typeface.MONOSPACE
            setPadding(dp(12), dp(12), dp(12), dp(12))
            setBackgroundColor(PANEL)
            setTextIsSelectable(true)
        }
        val retry = Button(this).apply {
            text = "Retry"
            isAllCaps = false
            setTextColor(TEXT)
            setBackgroundColor(PANEL)
            setOnClickListener { recreate() }
        }
        content.addView(
            title,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )
        content.addView(heading)
        content.addView(codeView)
        content.addView(
            reasonView,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )
        content.addView(
            commandView,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = dp(20) },
        )
        content.addView(
            retry,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = dp(16) },
        )
        scroll.addView(
            content,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )
        setContentView(scroll)
        enterImmersive()
    }

    private fun logConfig(config: AppConfig, warnings: List<String>) {
        Log.i(
            TAG,
            "config dashboard=${redactUrl(config.dashboardUrl)} " +
                "prometheus=${config.prometheusUrl?.let(::redactUrl) ?: "none"} " +
                "kiosk=${config.kiosk} debug=${config.debug} display=${config.displayMode} " +
                "layout=${config.layoutMode} lock_style=${config.lockStyle} " +
                "dashboard_source=${config.dashboardSource} collector=${config.collector} " +
                "collector_phone=${config.collectorPhone} " +
                "dashboards=${config.dashboardUrls.size} rotate_seconds=${config.rotateSeconds}",
        )
        if (config.collector) {
            Log.i(
                TAG,
                "collector=true: renderer uses prometheus_url=${CollectorConfig.URL} " +
                    "instead of the configured URL",
            )
        }
        warnings.forEach { Log.w(TAG, it) }
    }

    private fun redactUrl(raw: String): String = try {
        val uri = Uri.parse(raw)
        val path = uri.path.orEmpty()
        val port = if (uri.port == -1) "" else ":${uri.port}"
        "${uri.scheme}://${uri.host}$port$path"
    } catch (_: Exception) {
        "[invalid-url]"
    }

    private fun sanitize(value: String, limit: Int): String {
        val cleaned = value.replace(Regex("[\\u0000-\\u001f]"), " ")
        return if (cleaned.length > limit) "${cleaned.take(limit - 1)}…" else cleaned
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    inner class Bridge {
        @JavascriptInterface
        fun platform(): String = "android"

        @JavascriptInterface
        fun appVersion(): String = BuildConfig.VERSION_NAME

        @JavascriptInterface
        fun reload() {
            runOnUiThread {
                rendererUrl?.let { webView?.loadUrl(it) }
            }
        }

        @JavascriptInterface
        fun exitKiosk() {
            runOnUiThread {
                CollectorService.stop(this@MainActivity)
                try {
                    stopLockTask()
                } catch (_: Exception) {
                    // Not pinned; immersive kiosk still exits.
                }
                finishAndRemoveTask()
            }
        }

        @JavascriptInterface
        fun log(level: String?, message: String?) {
            val safeLevel = level?.lowercase()?.take(16) ?: "info"
            val safeMessage = sanitize(message.orEmpty(), 300)
            when (safeLevel) {
                "error" -> Log.e(TAG, "renderer: $safeMessage")
                "warn" -> Log.w(TAG, "renderer: $safeMessage")
                "debug" -> Log.d(TAG, "renderer: $safeMessage")
                else -> Log.i(TAG, "renderer: $safeMessage")
            }
        }

        /**
         * Renderer option choice (C-007): one of `time_range`, `refresh_seconds`,
         * `layout_mode`, `lock_style`, `dashboard_source`, `dashboard_url`,
         * `dashboard_urls`, `rotate_seconds`, `collector`, `collector_targets`,
         * validated with the C-001 launch rules (and the C-007 list rules) on
         * this bridge thread against the current config. Returns `""` when the
         * option is accepted, else a short error (at most 120 characters). An
         * accepted option is applied on the UI thread: persisted, folded into
         * the renderer URL so `reload()` keeps it, and, when it changes the
         * collector, the collector service and (for a changed Prometheus URL)
         * the renderer are restarted.
         */
        @JavascriptInterface
        fun setOption(name: String?, value: String?): String {
            if ((name?.length ?: 0) > ConfigParser.MAX_OPTION_INPUT ||
                (value?.length ?: 0) > ConfigParser.maxOptionValue(name)
            ) {
                Log.w(TAG, "setOption rejected: input too long")
                return "setOption input is too long"
            }
            val current = config
            if (fatal || current == null) {
                Log.w(TAG, "setOption rejected: no live config")
                return "setOption is unavailable"
            }
            return try {
                ConfigParser.applyOption(current, name, value)
                runOnUiThread { updateOption(name, value) }
                ""
            } catch (error: ConfigException) {
                val message = sanitize(error.message.orEmpty(), MAX_ERROR)
                Log.w(TAG, "setOption rejected: $message")
                message
            } catch (error: RuntimeException) {
                Log.w(TAG, "setOption failed: ${error.javaClass.simpleName}")
                "setOption failed"
            }
        }

        /**
         * Store a dashboard document pasted in the settings sheet (C-007): a
         * single JSON object of at most [DashboardStore.MAX_BYTES] characters,
         * kept verbatim in [InlineDashboards]. Returns its
         * `http://androdash.local/inline/<id>.json` URL, or `""` when rejected;
         * `dashboard_urls` is unchanged (the renderer adds the URL with
         * `setOption`). File IO runs on this bridge thread. Logs size and id,
         * never contents.
         */
        @JavascriptInterface
        fun addInlineDashboard(json: String?): String {
            return try {
                val current = config
                if (fatal || current == null) {
                    Log.w(TAG, "addInlineDashboard rejected: no live config")
                    return ""
                }
                if (json == null || json.length > DashboardStore.MAX_BYTES) {
                    Log.w(TAG, "addInlineDashboard rejected: ${json?.length ?: 0} chars")
                    return ""
                }
                val url = inlineDashboards.write(json, current.dashboardUrls)
                Log.i(TAG, "inline dashboard stored (${InlineDashboards.idOf(url)}, ${json.length} chars)")
                url
            } catch (error: IllegalArgumentException) {
                Log.w(TAG, "addInlineDashboard rejected: ${sanitize(error.message.orEmpty(), MAX_ERROR)}")
                ""
            } catch (error: Exception) {
                Log.w(TAG, "addInlineDashboard failed: ${error.javaClass.simpleName}")
                ""
            }
        }

        @JavascriptInterface
        fun lockScreenEnabled(): Boolean = showWhenLocked

        /**
         * On-phone collector state (C-007): JSON of at most 4 KiB with
         * `enabled`, `running`, `url`, `targets`, `restarts`, `startedAt`,
         * `lastExit`. Never throws to JS.
         */
        @JavascriptInterface
        fun collectorStatus(): String = try {
            CollectorStatus.of(config, CollectorService.runtime).toJson()
        } catch (error: Exception) {
            Log.w(TAG, "collectorStatus failed: ${error.javaClass.simpleName}")
            CollectorStatus.UNAVAILABLE
        }

        /**
         * Store the dashboard JSON the renderer just fetched from [sourceUrl]
         * (C-007, `dashboard_source=stored`) in the slot of its position in
         * `dashboard_urls`. Accepted only for a current `dashboard_urls` entry,
         * never for a bundled `androdash.local` URL, and only for a JSON object
         * of at most [DashboardStore.MAX_BYTES]. File IO runs on this bridge
         * thread. Logs sizes and slots, never contents or URLs.
         */
        @JavascriptInterface
        fun storeDashboard(sourceUrl: String?, json: String?): Boolean {
            return try {
                val current = config
                val slot = current?.let { DashboardStore.slotFor(it, sourceUrl) }
                if (fatal || slot == null) {
                    Log.w(TAG, "storeDashboard rejected: not a current stored-mode dashboard")
                    return false
                }
                if (json == null || json.length > DashboardStore.MAX_BYTES) {
                    Log.w(TAG, "storeDashboard rejected: ${json?.length ?: 0} chars")
                    return false
                }
                val bytes = dashboardStore.write(slot, sourceUrl!!, json)
                Log.i(TAG, "dashboard stored (slot $slot, $bytes bytes)")
                true
            } catch (error: IllegalArgumentException) {
                Log.w(TAG, "storeDashboard rejected: ${sanitize(error.message.orEmpty(), 120)}")
                false
            } catch (error: Exception) {
                Log.w(TAG, "storeDashboard failed: ${error.javaClass.simpleName}")
                false
            }
        }

        /** Forget every stored dashboard copy (C-007). Never throws to JS. */
        @JavascriptInterface
        fun clearStoredDashboard() {
            try {
                dashboardStore.clear()
                Log.i(TAG, "stored dashboards cleared")
            } catch (error: Exception) {
                Log.w(TAG, "clearStoredDashboard failed: ${error.javaClass.simpleName}")
            }
        }

        @JavascriptInterface
        fun setLockScreen(enabled: Boolean) {
            runOnUiThread { updateLockScreen(enabled) }
        }
    }

    /**
     * UI-thread half of `setOption`: re-apply the option to the config current
     * now (it was validated on the bridge thread), persist it, and fold it into
     * [rendererUrl]. A changed `dashboard_urls` prunes inline dashboards; a
     * changed `collector`/`collector_targets` re-syncs the collector service;
     * a changed renderer Prometheus URL reloads the renderer with the new URL.
     */
    private fun updateOption(name: String?, value: String?) {
        val current = config ?: return
        if (fatal) return
        try {
            val update = ConfigParser.applyOption(current, name, value)
            val next = update.config
            config = next
            rendererUrl = ConfigParser.launchUrl(next)
            configStore.save(next)
            update.warnings.forEach { Log.w(TAG, it) }
            Log.i(
                TAG,
                "option set time_range=${next.timeRange ?: "default"} " +
                    "refresh_seconds=${next.refreshSeconds ?: "default"} " +
                    "layout_mode=${next.layoutMode} lock_style=${next.lockStyle} " +
                    "dashboard_source=${next.dashboardSource} " +
                    "dashboard=${next.dashboardUrls.indexOf(next.dashboardUrl) + 1}/" +
                    "${next.dashboardUrls.size} rotate_seconds=${next.rotateSeconds} " +
                    "collector=${next.collector} scrape_targets=${CollectorConfig.configuredTargets(next).size}",
            )
            if (next.dashboardUrls != current.dashboardUrls) pruneInline(next)
            if (next.collector != current.collector || next.collectorTargets != current.collectorTargets) {
                syncCollector(next)
            }
            if (ConfigParser.rendererPrometheusUrl(next) != ConfigParser.rendererPrometheusUrl(current)) {
                Log.i(TAG, "prometheus source changed; reloading renderer")
                setupWebView()
            }
        } catch (error: ConfigException) {
            Log.w(TAG, "setOption rejected: ${sanitize(error.message.orEmpty(), MAX_ERROR)}")
        }
    }

    private fun updateLockScreen(enabled: Boolean) {
        val current = config ?: return
        if (fatal) return
        if (enabled && !current.kiosk) {
            Log.w(TAG, "setLockScreen ignored: kiosk=false")
            return
        }
        configStore.saveShowWhenLocked(enabled)
        if (enabled != showWhenLocked) applyShowWhenLocked(enabled)
    }

    companion object {
        private const val TAG = "AndroDash"
        /** Longest error text returned to (or logged for) the renderer. */
        private const val MAX_ERROR = 120
        private const val LOCKED_BRIGHTNESS = 0.12f
        private const val RELIGHT_SETTLE_MILLIS = 300L
        private const val RELIGHT_WAKE_LOCK_TAG = "androdash:relight"
        private const val JS_SET_LOCKED_TRUE =
            "window.androdash && window.androdash.setLocked && window.androdash.setLocked(true)"
        private const val JS_SET_LOCKED_FALSE =
            "window.androdash && window.androdash.setLocked && window.androdash.setLocked(false)"
        private const val BRIDGE_NAME = "AndroDash"
        private const val STATE_URL = "renderer_url"
        /** C-009 launch extra: http(s) URL of an Ignition document. */
        private const val IGNITION_EXTRA = "ignition_url"
        /** C-009 app-private Ignition source, `<filesDir>/ignition.json`. */
        private const val IGNITION_FILE = "ignition.json"
        private const val IGNITION_TIMEOUT_MILLIS = 10_000
        private val BACKGROUND = Color.rgb(8, 11, 18)
        private val PANEL = Color.rgb(17, 24, 32)
        private val TEXT = Color.rgb(231, 238, 246)
        private val MUTED = Color.rgb(139, 155, 173)
        private val ACCENT = Color.rgb(76, 201, 240)
        private val CRITICAL = Color.rgb(255, 154, 154)
        private const val COMMAND_SHAPE =
            "adb shell am start -n com.mbicz.androdash/.MainActivity \\\n" +
                "  --es dashboard_url \"https://example.com/dashboard.json\" \\\n" +
                "  --es prometheus_url \"https://prometheus.example.com\""
    }
}
