package com.dissonance.wfarer.spressorca

import android.content.Context
import android.util.Log
import java.io.File

/**
 * Copies the bundled `assets/www/` tree to `filesDir/www/` on first run
 * (or when the bundled version marker changes).
 *
 * We serve from the filesystem rather than directly from `assets/` because
 * NanoHTTPD's range-request handling (which WebView issues for the ~400 KB
 * AudioWorklet processor and for soundfonts) only works reliably on real,
 * seekable files. `AssetManager.open()` returns a non-seekable stream.
 *
 * Idempotent: a version marker file (`filesDir/www/.asset-version`) records
 * which build was last copied. The marker is bumped whenever the bundled
 * assets change (tied to versionCode), so a new APK triggers a re-copy.
 */
object AssetCopier {

    private const val TAG = "AssetCopier"
    private const val ASSET_ROOT = "www"
    private const val VERSION_MARKER = ".asset-version"

    /**
     * Ensure `filesDir/www/` is up to date with `assets/www/`.
     * Call this off the main thread (it does disk I/O).
     *
     * @param versionCode the app's versionCode; baked into the marker so an
     *   APK update re-copies the assets.
     * @param onProgress optional callback invoked with (filesCopied, totalBytesCopied,
     *   currentRelativePath) as each file finishes. Useful for a first-run loading UI.
     * @return true if a copy actually happened (vs. skipped as up-to-date).
     */
    fun ensureCopied(
        context: Context,
        versionCode: Int,
        onProgress: ((copied: Int, bytes: Long, path: String) -> Unit)? = null
    ): Boolean {
        val targetDir = File(context.filesDir, ASSET_ROOT)
        val marker = File(targetDir, VERSION_MARKER)
        val expected = versionCode.toString()

        if (marker.exists() && marker.readText().trim() == expected) {
            Log.d(TAG, "Assets up to date (version=$expected), skipping copy.")
            onProgress?.invoke(-1, -1, "") // signal: no copy needed
            return false
        }

        Log.i(TAG, "Copying assets/www/ → ${targetDir.absolutePath}")
        if (targetDir.exists()) targetDir.deleteRecursively()
        targetDir.mkdirs()

        val state = CopyState()
        val assetManager = context.assets
        copyRecursive(assetManager, ASSET_ROOT, targetDir, state, onProgress)

        marker.writeText(expected)
        Log.i(TAG, "Copy complete: ${state.files} files, ${state.bytes / 1024} KB.")
        return true
    }

    private class CopyState { var files = 0; var bytes = 0L }

    /** Recursively copy every file under [assetPath] in the AssetManager to [dest]. */
    private fun copyRecursive(
        assetManager: android.content.res.AssetManager,
        assetPath: String,
        dest: File,
        state: CopyState,
        onProgress: ((Int, Long, String) -> Unit)?
    ) {
        val children = assetManager.list(assetPath) ?: run {
            Log.w(TAG, "Asset dir '$assetPath' is empty or missing.")
            return
        }
        if (children.isEmpty()) {
            // assetPath is actually a file (AssetManager lists empty array for files).
            // This branch is reached only for empty leaf dirs, which we ignore.
            return
        }
        dest.mkdirs()
        for (child in children) {
            val childAssetPath = if (assetPath.isEmpty()) child else "$assetPath/$child"
            val childDest = File(dest, child)

            // Distinguish file vs. dir: list() returns null for a file, an array for a dir.
            val subChildren = assetManager.list(childAssetPath)
            if (subChildren != null && subChildren.isNotEmpty()) {
                copyRecursive(assetManager, childAssetPath, childDest, state, onProgress)
            } else {
                // It's a file. Copy it byte-for-byte. Use a buffered stream for the
                // large soundfont files (multi-MB) to avoid read() per byte.
                val started = System.currentTimeMillis()
                assetManager.open(childAssetPath).use { input ->
                    childDest.outputStream().use { output ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            output.write(buf, 0, n)
                            state.bytes += n
                        }
                    }
                }
                state.files++
                val ms = System.currentTimeMillis() - started
                Log.d(TAG, "  copied $childAssetPath (${childDest.length() / 1024} KB, ${ms} ms)")
                onProgress?.invoke(state.files, state.bytes, childAssetPath)
            }
        }
    }
}
