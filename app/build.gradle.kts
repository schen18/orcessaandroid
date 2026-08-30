plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.dissonance.wfarer.spressorca"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.dissonance.wfarer.spressorca"
        // Android 8.0+: guarantees a modern Chromium WebView with AudioWorklet,
        // ES modules, and import maps (all Play-updatable).
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // For Play Store distribution, configure a signing config in
            // ~/.gradle/gradle.properties (storeFile/storePassword/keyAlias/keyPassword)
            // and reference it here. See README-ANDROID.md.
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    // Keep the WebView assets uncompressed so .sf2/.sf3 and the AudioWorklet
    // processor open as seekable streams when AssetCopier reads them.
    androidResources {
        noCompress.addAll(listOf("sf2", "sf3", "sfogg"))
    }

    buildFeatures {
        viewBinding = true
    }

    lint {
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    // Lightweight single-file HTTP server for serving bundled assets to the WebView.
    implementation("org.nanohttpd:nanohttpd:2.2.0")
}
