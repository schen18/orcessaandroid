package com.dissonance.wfarer.spressorca

import fi.iki.elonen.NanoHTTPD
import java.io.File
import java.io.InputStream

/**
 * Serves the orcessa web app from `filesDir/www/` to the WebView over
 * loopback HTTP.
 *
 * Design notes:
 *  - Binds to 127.0.0.1 only. No other app on the device can reach it.
 *  - Port 0 → OS picks a free port; retrieve via [port] after [start].
 *  - `.js` / `.mjs` MUST be served as `text/javascript` — Chromium rejects ES
 *    module scripts (and AudioWorklet addModule) on any other MIME. This is
 *    the single most common footgun when bundling module-based web apps.
 *  - Directory requests resolve to `index.html` (so `/` → /index.html).
 *  - `/soundfonts/` returns a minimal HTML anchor listing so the app's hosted-
 *    soundfont auto-discovery works without the manifest fallback.
 *  - HTTP Range requests ARE implemented (NanoHTTPD 2.2.0 has no built-in
 *    support). WebView/media fetches issue Range requests for the multi-MB
 *    soundfonts and the ~400 KB AudioWorklet processor; without 206 Partial
 *    Content support every fetch reads the whole file and resumption fails.
 */
class WebServer(
    private val webRoot: File
) : NanoHTTPD("127.0.0.1", 0) {

    /** The actual port the OS assigned after [start]. -1 until started. */
    val port: Int get() = listeningPort

    override fun serve(session: IHTTPSession): Response {
        val rawUri = session.uri.trimStart('/')
        // Decode percent-escapes (NanoHTTPD gives us the raw path).
        val decoded = try {
            java.net.URLDecoder.decode(rawUri, "UTF-8")
        } catch (e: Exception) {
            rawUri
        }

        val requested = File(webRoot, decoded).canonicalFile

        // Path-traversal guard: must stay inside webRoot. Allow the webRoot itself
        // (a "/" request resolves to exactly webRoot, with no trailing separator)
        // OR any path beneath it (checked with a trailing separator so a sibling
        // like filesDir/www_evil can't sneak past "filesDir/www".startsWith(...)).
        val rootCanonical = webRoot.canonicalFile.path
        val requestedPath = requested.path
        if (requestedPath != rootCanonical &&
            !requestedPath.startsWith(rootCanonical + File.separator)) {
            return newFixedLengthResponse(Response.Status.FORBIDDEN, MIME_PLAINTEXT, "Forbidden")
        }

        // Directory: serve index.html, or a listing for /soundfonts/.
        if (requested.isDirectory) {
            val index = File(requested, "index.html")
            if (index.isFile) return serveFile(index, session)

            // Expose a simple listing for the soundfonts folder so the app's
            // hosted-soundfont auto-discovery finds files dropped in at build
            // time without needing to edit index.json.
            if (requested.name == "soundfonts") {
                val listing = generateDirectoryListing(requested, decoded)
                return newFixedLengthResponse(Response.Status.OK, "text/html; charset=utf-8", listing)
            }
            return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain; charset=utf-8", "Not found")
        }

        return if (requested.isFile) {
            serveFile(requested, session)
        } else {
            newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain; charset=utf-8", "404 Not Found")
        }
    }

    /**
     * Serve a single file with the correct MIME type, Content-Length, and
     * HTTP Range support (206 Partial Content). Range support is needed
     * because NanoHTTPD 2.2.0 lacks it and WebView issues Range requests
     * for large resources.
     */
    private fun serveFile(file: File, session: IHTTPSession): Response {
        val mime = mimeTypeFor(file.name)
        val total = file.length()

        // Check for a Range header (NanoHTTPD lowercases header keys).
        val rangeHeader = session.headers?.get("range")
            ?: session.headers?.get("Range")

        if (rangeHeader != null) {
            val range = parseRange(rangeHeader, total) ?: return fullResponse(file, mime)
            val input = boundedStream(file, range.start, range.length)
            val resp = newFixedLengthResponse(
                Response.Status.PARTIAL_CONTENT, mime, input, range.length
            )
            resp.addHeader("Content-Range", "bytes ${range.start}-${range.end}/$total")
            resp.addHeader("Accept-Ranges", "bytes")
            return resp
        }

        return fullResponse(file, mime)
    }

    private fun fullResponse(file: File, mime: String): Response {
        val resp = newFixedLengthResponse(
            Response.Status.OK, mime, file.inputStream(), file.length()
        )
        resp.addHeader("Accept-Ranges", "bytes")
        return resp
    }

    /** Parse a "bytes=start-end" / "bytes=start-" Range header. Null = unhandled/fallback. */
    private fun parseRange(header: String, total: Long): LongRangeSpec? {
        // Guard empty/zero-length files: coerceIn(0, total-1) below would throw
        // IllegalArgumentException("maximum -1 is less than minimum 0") which is
        // not caught by NumberFormatException. Falling back to a full 200 response
        // (which serves 0 bytes) is correct for an empty body.
        if (total <= 0) return null
        val h = header.trim()
        if (!h.startsWith("bytes=")) return null
        val spec = h.removePrefix("bytes=").trim()
        // Handle only a single range (the common WebView case).
        val part = spec.substringBefore(",")
        val dash = part.indexOf('-')
        if (dash < 0) return null
        val startStr = part.substring(0, dash).trim()
        val endStr = part.substring(dash + 1).trim()
        return try {
            val start: Long
            val end: Long
            if (startStr.isEmpty()) {
                // "bytes=-N" = last N bytes
                val n = endStr.toLong()
                start = (total - n).coerceAtLeast(0)
                end = total - 1
            } else {
                start = startStr.toLong().coerceIn(0, total - 1)
                end = if (endStr.isEmpty()) total - 1 else endStr.toLong().coerceIn(start, total - 1)
            }
            if (start > end) return null
            LongRangeSpec(start, end)
        } catch (e: NumberFormatException) {
            null
        }
    }

    /** Open [file] and skip to [start], limiting the stream to [length] bytes. */
    private fun boundedStream(file: File, start: Long, length: Long): InputStream {
        val fis = file.inputStream()
        var skipped = 0L
        while (skipped < start) {
            val s = fis.skip(start - skipped)
            if (s <= 0) break
            skipped += s
        }
        return BoundedInputStream(fis, length)
    }

    private data class LongRangeSpec(val start: Long, val end: Long) {
        val length: Long get() = end - start + 1
    }

    /** InputStream wrapper that reads at most [maxBytes] bytes, then EOFs. */
    private class BoundedInputStream(private val source: InputStream, private val maxBytes: Long) : InputStream() {
        private var remaining = maxBytes
        override fun read(): Int {
            if (remaining <= 0) return -1
            val b = source.read()
            if (b >= 0) remaining--
            return b
        }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (remaining <= 0) return -1
            val toRead = minOf(len, remaining.toInt())
            val n = source.read(b, off, toRead)
            if (n > 0) remaining -= n
            return n
        }
    }

    /** Minimal HTML directory listing the app's parser understands (anchor hrefs). */
    private fun generateDirectoryListing(dir: File, urlPath: String): String {
        val sb = StringBuilder()
        sb.append("<!DOCTYPE html><html><head><meta charset=\"utf-8\">")
        sb.append("<title>Index of /").append(urlPath).append("</title></head><body>")
        sb.append("<h1>Index of /").append(urlPath).append("</h1><ul>")
        val files = dir.listFiles()?.sortedBy { it.name.lowercase() } ?: emptyList()
        for (f in files) {
            if (f.name.startsWith(".")) continue
            sb.append("<li><a href=\"").append(f.name).append("\">").append(f.name).append("</a></li>")
        }
        sb.append("</ul></body></html>")
        return sb.toString()
    }

    private fun mimeTypeFor(filename: String): String {
        val ext = filename.substringAfterLast('.', "").lowercase()
        return when (ext) {
            "html", "htm" -> "text/html; charset=utf-8"
            "css"         -> "text/css; charset=utf-8"
            // CRITICAL: must be a JavaScript MIME type or ES modules + AudioWorklet
            // are rejected. NOT application/octet-stream.
            "js", "mjs"   -> "text/javascript; charset=utf-8"
            "json", "map" -> "application/json; charset=utf-8"
            "svg"         -> "image/svg+xml"
            "png"         -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "gif"         -> "image/gif"
            "ico"         -> "image/x-icon"
            "woff"        -> "font/woff"
            "woff2"       -> "font/woff2"
            "ttf"         -> "font/ttf"
            "otf"         -> "font/otf"
            "wasm"        -> "application/wasm"
            "sf2", "sf3", "sfogg" -> "application/octet-stream"
            else          -> "application/octet-stream"
        }
    }
}
