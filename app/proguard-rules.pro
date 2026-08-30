# R8 / ProGuard rules for com.dissonance.wfarer.spressorca
#
# Minification (isMinifyEnabled) is currently OFF in build.gradle.kts; these
# rules are wired up for release builds so enabling R8 later won't break the
# WebView JavaScript bridge.

# The JavaScript bridge is invoked reflectively from JS by method name
# (webView.addJavascriptInterface(..., "Android") in MainActivity), so its
# @JavascriptInterface methods must keep their names.
-keepclassmembers class com.dissonance.wfarer.spressorca.MainActivity$WebAppInterface {
    @android.webkit.JavascriptInterface <methods>;
}
