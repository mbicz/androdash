import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Bundled dashboards: every contracts fixture named *-dashboard.json is served
// at http://androdash.local/dashboards/<file> (C-001, AssetServer). The
// generated directory is an extra assets root; preBuild runs the copy, so every
// variant task (merge assets, lint, assemble) sees it.
val dashboardAssetsDir = layout.buildDirectory.dir("generated/dashboard-assets")
val copyDashboardAssets = tasks.register<Copy>("copyDashboardAssets") {
    from("$rootDir/contracts/fixtures") {
        include("*-dashboard.json")
        into("dashboards")
    }
    into(dashboardAssetsDir)
}
tasks.named("preBuild") { dependsOn(copyDashboardAssets) }

android {
    namespace = "com.mbicz.androdash"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.mbicz.androdash"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets {
        getByName("main").assets.srcDirs(
            "$rootDir/web/app",
            dashboardAssetsDir.get().asFile,
        )
    }

    testOptions {
        unitTests.isIncludeAndroidResources = false
    }

    lint {
        abortOnError = true
        warningsAsErrors = false
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    // android.jar's org.json is a stub on the JVM; AppConfig persistence tests need the real one.
    testImplementation("org.json:json:20260814")
}
