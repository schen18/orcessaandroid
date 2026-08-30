# orcessa for Android

Bundles the orcessa web app into a native Android APK. An in-app NanoHTTPD
server serves the web assets to a WebView over loopback HTTP
(`http://127.0.0.1:<port>/`); the web app runs **unmodified**.

## Requirements

- Android Studio (Hedgehog / 2023.1.1 or newer recommended)
- JDK 17
- Android SDK with **API 36** (compile) and **API 26** (minimum) installed
- An emulator or device running Android 8.0 (API 26) or newer

> **Why API 26+?** AudioWorklet, ES modules, and import maps all require a
> modern Chromium WebView. Since Android 7, WebView is a Play-updatable
> Chromium package; API 26 guarantees any device that still has working Play
> Services is on a current Chromium.

## Build

### With Android Studio (easiest)

1. Open the `android/` folder in Android Studio.
2. Let Gradle sync (it will download the Gradle wrapper jar + dependencies on
   first run).
3. Press **Run** ▶ to build and launch on an emulator or connected device.

### From the command line

```bash
cd android
./gradlew assembleDebug
# → APK at app/build/outputs/apk/debug/app-debug.apk
```

Install on a connected device (USB debugging on):

```bash
./gradlew installDebug
# or
adb install app/build/outputs/apk/debug/app-debug.apk
```

### Release build (for distribution)

```bash
./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release-unsigned.apk
```

For Play Store submission you must sign the APK. Configure a signing config
in `~/.gradle/gradle.properties`:

```properties
ORCESSA_STORE_FILE=/absolute/path/to/your.keystore
ORCESSA_STORE_PASSWORD=*****
ORCESSA_KEY_ALIAS=orcessa
ORCESSA_KEY_PASSWORD=*****
```

…and add a `signingConfigs` block to `app/build.gradle.kts` referencing those
properties, then `./gradlew assembleRelease` produces a signed APK / AAB.

## How it works

```
onCreate()
  → (background thread) AssetCopier.ensureCopied()
      copies assets/www/ → filesDir/www/  (first run or version bump)
  → WebServer.start()    (NanoHTTPD bound to 127.0.0.1:0)
  → reads the assigned port
  → WebView.loadUrl("http://127.0.0.1:<port>/")
onDestroy()
  → WebServer.stop()
```

- **Why copy assets to `filesDir`?** `AssetManager.open()` returns a
  non-seekable stream; WebView issues `Range` requests for the ~400 KB
  AudioWorklet processor and for soundfonts, and range serving only works
  reliably on real files. The copy happens once (gated by a version marker)
  and is ~1.5 MB.
- **Why `127.0.0.1` and not `file://`?** AudioWorklet and ES modules are
  secure-context-only in Chromium. `file://` is rejected; `http://127.0.0.1`
  is treated as a secure context.
- **Cleartext traffic** is allowlisted for `127.0.0.1`/`localhost` only via
  `res/xml/network_security_config.xml`. The server binds to the loopback
  interface, so no other app on the device can reach it.

## Refreshing the bundled web app

After changing any web-side file (`index.html`, `src/`, `vendor/`,
`soundfonts/`, `styles.css`), re-sync and rebuild:

```bash
cd android
./sync-assets.sh           # copies ../{index.html,src,vendor,...} → assets/www/
```

**Bump `versionCode`** in `app/build.gradle.kts` so `AssetCopier` re-copies
the fresh assets on existing installs (the version marker keys off it):

```kotlin
versionCode = 2   // was 1
```

Then rebuild.

## Bundling soundfonts into the APK

Drop `.sf2` / `.sf3` / `.sfogg` files into `soundfonts/` (at the repo root)
**before** running `./sync-assets.sh`. They land in
`assets/www/soundfonts/`, get copied to `filesDir/www/soundfonts/` at runtime,
and the app's hosted-soundfont auto-discovery finds them (the embedded server
returns a directory listing for `/soundfonts/`). Alternatively edit
`soundfonts/index.json` to list them explicitly.

**APK size note:** every soundfont in `soundfonts/` is baked into the APK and
copied to internal storage on first run. With the current ~125 MB of bundled
soundfonts, the APK is ~125 MB and the first launch shows a loading overlay
("Copying bundled soundfonts…") while the copy runs on a background thread
(typically a few seconds on modern devices). Subsequent launches skip the copy
(version-gated by `versionCode`). To ship a smaller APK, remove soundfont
files from `soundfonts/` before syncing — users can still load their own via
the file picker.

## Background audio (currently: pause)

**v1 behavior:** audio pauses when the app is backgrounded and resumes cleanly
when it returns. This is the simplest robust behavior and avoids a foreground
service + notification.

### Upgrade path (to keep audio playing in the background)

To enable background audio, you need two things:

1. **A foreground `Service`** with `foregroundServiceType="mediaPlayback"`,
   a persistent notification, and a `PowerManager` wake lock. Uncomment the
   permissions and `<service>` block in
   `app/src/main/AndroidManifest.xml` (marked `BACKGROUND AUDIO UPGRADE PATH`),
   create an `AudioService.kt`, and start/stop it from `MainActivity`'s
   lifecycle.

2. **(The hard part) move the Orca clock off background-throttled timers.**
   Even with a foreground service keeping the *process* alive, Android
   WebView aggressively throttles background timers — including Orca's
   Web Worker clock (`setTimeout`/`setInterval` get clamped to ~once/minute
   in the background). The *synth* (SpessaSynth, which runs on the AudioWorklet
   audio thread) is **not** throttled and will keep playing any in-flight
   notes — but the *sequencer* (Orca's clock) will stutter.

   The robust fix is to drive sequencing from the AudioWorklet thread (which
   is immune to the timer throttle) rather than Orca's Web Worker. That is a
   meaningful refactor of the web app's timing architecture and is out of
   scope for v1.

   A pragmatic middle ground: keep the activity foregrounded (e.g., use
   Picture-in-Picture mode) while the user wants audio to continue.

## Project layout

```
android/
├── app/
│   ├── build.gradle.kts
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── assets/www/                 ← web app (synced via ./sync-assets.sh)
│       ├── java/com/dissonance/wfarer/spressorca/
│       │   ├── MainActivity.kt         ← WebView + server lifecycle
│       │   ├── WebServer.kt            ← NanoHTTPD: serves filesDir/www/
│       │   └── AssetCopier.kt          ← first-run assets → filesDir copy
│       └── res/{xml,values,drawable,mipmap-anydpi-v26}/
├── build.gradle.kts
├── settings.gradle.kts
├── gradle.properties
├── gradle/wrapper/gradle-wrapper.properties
├── gradlew
└── sync-assets.sh                      ← refresh assets/www/ from repo root
```

## Troubleshooting

- **Blank screen / "Failed to load module script"** — almost always a wrong
  `.js` MIME type. The `WebServer` maps `.js`/`.mjs` to `text/javascript`;
  don't change that to `application/octet-stream` or ES modules break.
- **"Audio worklet is not supported"** — the device's Android System WebView is
  too old. Update WebView via the Play Store, or raise `minSdk`.
- **`cleartext HTTP traffic to 127.0.0.1 not permitted`** — the
  `network_security_config.xml` isn't referenced from the manifest, or was
  shadowed by `android:usesCleartextTraffic="false"`.
- **APK installs but nothing plays** — check `adb logcat` for the
  `orcessa`, `AssetCopier`, and `WebServer` tags; the server URL and any
  errors are logged there.
