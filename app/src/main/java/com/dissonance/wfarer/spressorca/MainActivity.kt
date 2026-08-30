package com.dissonance.wfarer.spressorca

import android.annotation.SuppressLint
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File

/**
 * Hosts the orcessa web app inside a WebView served by an in-app NanoHTTPD
 * loopback server.
 *
 * Lifecycle:
 *   onCreate  → (background) copy assets → start server → WebView.loadUrl()
 *   onDestroy → stop server
 *
 * Background audio (v1): audio pauses when the app is backgrounded. This is
 * the simplest robust behavior. To keep audio playing in the background, see
 * the upgrade-path notes in README-ANDROID.md and the TODOs in
 * AndroidManifest.xml.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var server: WebServer? = null
    // File picker callback for WebView.
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private val filePickerLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val uris = if (result.resultCode == RESULT_OK) {
            val data = result.data
            if (data?.clipData != null) {
                val count = data.clipData!!.itemCount
                Array(count) { i -> data.clipData!!.getItemAt(i).uri }
            } else if (data?.data != null) {
                arrayOf(data.data!!)
            } else null
        } else null
        fileChooserCallback?.onReceiveValue(uris)
        fileChooserCallback = null
    }
    // Guarded by `lock`; prevents the background startup thread from assigning a
    // server after onDestroy has already torn one down (or after disposal), which
    // would leak the listening socket + thread pool for the process lifetime.
    private val lock = Any()
    private var disposed = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Keep the screen on while the activity is visible so the Orca clock
        // (Web Worker-driven) doesn't stutter during interactive use.
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Draw edge-to-edge and let us pad the content to the safe region ourselves.
        // This makes system-bar insets report reliably on every API level (Android
        // 15+ enforces edge-to-edge anyway), so the app content stays out from
        // under the status bar (notifications) and the nav bar (gesture/buttons).
        WindowCompat.setDecorFitsSystemWindows(window, false)

        webView = WebView(this)

        // Loading overlay: shown during the (potentially long, ~125 MB on first
        // run) asset copy, removed once the WebView page finishes loading.
        val overlay = buildLoadingOverlay()
        val lp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        val root = FrameLayout(this).apply {
            addView(webView, lp)
            addView(overlay, lp)
        }
        // Keep the app content out from under the status bar (notifications area)
        // and the navigation bar (gesture/buttons area). We pad the root view by
        // the system-bar insets so the WebView and overlay stay in the safe region.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        setContentView(root)

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                overlay.visibility = View.GONE
            }
            override fun onReceivedError(
                view: WebView?, request: android.webkit.WebResourceRequest?,
                error: android.webkit.WebResourceError?
            ) {
                // Dismiss the loading overlay on error too, so the spinner never
                // stays up forever if the page fails to load.
                overlay.visibility = View.GONE
            }
        }

        // Optional WebView version guard: AudioWorklet + import maps need
        // Chromium 89+. minSdk 26 guarantees an updatable WebView, but very
        // old/unmaintained devices may have a frozen old one. Log it for
        // diagnostics; a hard fail could go here if desired.
        logWebViewVersion()

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true            // Orca/SpessaSynth use localStorage
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false  // audio can start without a tap (the web app gates on its own button)
            // We serve over http://127.0.0.1 via our own server; do NOT enable
            // file:// access — we never load from the filesystem.
            allowFileAccess = false
            allowUniversalAccessFromFileURLs = false
            allowFileAccessFromFileURLs = false
            // Cache: assets are local already; default caching is fine.
            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
        }

        // Route page navigations inside this WebView (don't hand off to a browser app).
        // (webViewClient is set above with onPageFinished to dismiss the overlay.)
        // Let console.log / alert / web-audio permissions resolve.
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = filePathCallback
                val intent = fileChooserParams?.createIntent()
                if (intent == null) {
                    fileChooserCallback = null
                    return false
                }
                try {
                    filePickerLauncher.launch(intent)
                } catch (e: Exception) {
                    fileChooserCallback = null
                    return false
                }
                return true
            }
        }
        webView.addJavascriptInterface(WebAppInterface(this), "Android")

        // Debugging: enable only on debuggable builds (release builds are off).
        if (0 != applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        // Start the server + load on a background thread (asset copy does disk I/O).
        Thread {
            try {
                AssetCopier.ensureCopied(this, getPackageInfo().versionCode) { files, bytes, _ ->
                    if (files < 0) return@ensureCopied // up-to-date; no copy
                    runOnUiThread { updateLoadingOverlay(overlay, files, bytes) }
                }
                val webRoot = File(filesDir, "www")
                val srv = WebServer(webRoot)
                srv.start(SOCKET_READ_TIMEOUT, false)
                // Atomically either claim the server or stop it if the activity
                // was destroyed while we were busy copying assets / starting up.
                val url: String
                synchronized(lock) {
                    if (disposed) {
                        Log.i(TAG, "Activity destroyed during startup; stopping server.")
                        srv.stop()
                        return@Thread
                    }
                    server = srv
                    url = "http://127.0.0.1:${srv.port}/"
                }
                Log.i(TAG, "Serving orcessa at $url")
                runOnUiThread { if (!isFinishing && !isDestroyed) webView.loadUrl(url) }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start orcessa server", e)
                runOnUiThread {
                    overlay.visibility = View.GONE
                    webView.loadDataWithBaseURL(
                        null,
                        "<body style='font-family:sans-serif;background:#0d0f12;color:#eee;padding:2em'>" +
                        "<h2>Failed to start orcessa</h2><pre>${e.message}</pre></body>",
                        "text/html", "utf-8", null
                    )
                }
            }
        }.start()
    }

    override fun onDestroy() {
        super.onDestroy()
        synchronized(lock) { disposed = true }
        try {
            server?.stop()
        } catch (e: Exception) {
            Log.w(TAG, "Error stopping server", e)
        }
        server = null
        // Detach the WebView from its parent before destroying it — the classic
        // Activity-context WebView leak vector. removeAllViews() alone only
        // removes the WebView's OWN children, not the WebView itself.
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.apply {
            stopLoading()
            removeAllViews()
            destroy()
        }
    }

    // Standard back-press handling: navigate WebView history before exiting.
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
    }

    private fun logWebViewVersion() {
        try {
            val info = WebView.getCurrentWebViewPackage()
            Log.i(TAG, "Android System WebView: ${info?.versionName} (${info?.versionCode})")
        } catch (e: Exception) {
            Log.w(TAG, "Could not read WebView package version", e)
        }
    }

    private fun getPackageInfo(): android.content.pm.PackageInfo =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            packageManager.getPackageInfo(packageName, android.content.pm.PackageManager.PackageInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            packageManager.getPackageInfo(packageName, 0)
        }

    /** Full-screen loading overlay shown during the first-run asset copy. */
    private fun buildLoadingOverlay(): View {
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(0xFF0D0F12.toInt())
            setPadding(48, 48, 48, 48)
        }
        val title = TextView(this).apply {
            text = "orcessa"
            setTextColor(0xFF72DEC2.toInt())
            textSize = 26f
            gravity = Gravity.CENTER
        }
        val status = TextView(this).apply {
            text = "Preparing soundfonts…"
            setTextColor(0xFFE6E9EE.toInt())
            textSize = 14f
            gravity = Gravity.CENTER
            setPadding(0, 32, 0, 0)
            tag = "status"
        }
        val progress = ProgressBar(this).apply {
            isIndeterminate = true
            setPadding(0, 40, 0, 0)
            tag = "progress"
        }
        container.addView(title)
        container.addView(status)
        container.addView(progress)
        return container
    }

    /** Update the overlay's status line as files copy. */
    private fun updateLoadingOverlay(overlay: View, files: Int, bytes: Long) {
        val status = overlay.findViewWithTag<TextView>("status") ?: return
        val mb = bytes / (1024 * 1024)
        status.text = "Copying bundled soundfonts…\n$files files · $mb MB"
    }

    /** JavaScript bridge for native features like clipboard access. */
    class WebAppInterface(private val context: Context) {
        @JavascriptInterface
        fun getClipboardText(): String {
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val item = clipboard.primaryClip?.getItemAt(0)
            return item?.text?.toString() ?: ""
        }
    }

    companion object {
        private const val TAG = "orcessa"
        // NanoHTTPD SOCKET_READ_TIMEOUT (ms). NanoHTTPD.DEFAULT_WAKEUP_INTERVAL-ish.
        private const val SOCKET_READ_TIMEOUT = 10000
    }
}
