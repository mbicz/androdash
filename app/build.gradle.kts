import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.net.URI
import java.security.MessageDigest
import java.util.zip.GZIPInputStream
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

// On-phone collector (decision 0019): the upstream Prometheus linux-arm64 release,
// pinned by version and SHA-256 (tarball and extracted binary). The tarball is
// cached outside build/ so clean builds work offline. Only `prometheus`,
// LICENSE, and NOTICE are extracted, streaming, with no intermediate copy.
// Upgrade: change the version, then pin both hashes from the release's
// sha256sums.txt and `tar -xzOf <tarball> <dir>/prometheus | shasum -a 256`.
val prometheusVersion = "3.15.1"
val prometheusTarballSha256 = "ceb6d21493c37ca0b4513b147642797c68cf39a0f50a444d50e1e80c74f21b26"
val prometheusBinarySha256 = "373c0a5428a2b63101267b31bb1af44e3b33d7ca8202df9d9e50b98635b3bb0f"
val collectorJniLibsDir = layout.buildDirectory.dir("generated/collector-jniLibs")
val collectorAssetsDir = layout.buildDirectory.dir("generated/collector-assets")

abstract class FetchPrometheus : DefaultTask() {
    @get:Input abstract val releaseVersion: Property<String>
    @get:Input abstract val tarballSha256: Property<String>
    @get:Input abstract val binarySha256: Property<String>

    /** Download cache outside build/; not an output, so `clean` keeps it. */
    @get:Internal abstract val cacheDir: DirectoryProperty

    @get:OutputDirectory abstract val jniLibsDir: DirectoryProperty
    @get:OutputDirectory abstract val assetsDir: DirectoryProperty

    @TaskAction
    fun fetch() {
        val release = "prometheus-${releaseVersion.get()}.linux-arm64"
        val tarball = cacheDir.get().file("$release.tar.gz").asFile
        tarball.parentFile.mkdirs()
        if (!tarball.isFile || sha256(tarball) != tarballSha256.get()) {
            download(
                "https://github.com/prometheus/prometheus/releases/download/v${releaseVersion.get()}/$release.tar.gz",
                tarball,
            )
        }
        val jniDir = jniLibsDir.get().asFile.apply { deleteRecursively() }
        val licenseDir = assetsDir.get().asFile.apply { deleteRecursively() }
        val wanted = mapOf(
            "$release/prometheus" to File(jniDir, "arm64-v8a/libprometheus.so"),
            "$release/LICENSE" to File(licenseDir, "licenses/prometheus/LICENSE"),
            "$release/NOTICE" to File(licenseDir, "licenses/prometheus/NOTICE"),
        )
        val digests = extract(tarball, wanted)
        val binary = wanted.getValue("$release/prometheus")
        if (digests[binary] != binarySha256.get()) {
            binary.delete()
            throw GradleException("prometheus binary SHA-256 mismatch: ${digests[binary]}")
        }
        logger.lifecycle("Prometheus ${releaseVersion.get()}: ${binary.length()} bytes, SHA-256 verified")
    }

    private fun download(url: String, target: File) {
        logger.lifecycle("Downloading $url")
        val part = File(target.parentFile, "${target.name}.part")
        val digest = MessageDigest.getInstance("SHA-256")
        URI(url).toURL().openStream().use { input ->
            part.outputStream().use { output -> copy(input, output::write, digest) }
        }
        val actual = hex(digest.digest())
        if (actual != tarballSha256.get()) {
            part.delete()
            throw GradleException("prometheus tarball SHA-256 mismatch: $actual")
        }
        if (!part.renameTo(target)) throw GradleException("cannot move $part to $target")
    }

    /** Stream the gzip'd ustar archive once; write only [wanted] entries. Returns their SHA-256. */
    private fun extract(tarball: File, wanted: Map<String, File>): Map<File, String> {
        val found = HashMap<File, String>()
        val header = ByteArray(512)
        GZIPInputStream(FileInputStream(tarball), 1 shl 16).use { input ->
            while (true) {
                if (!readFully(input, header)) throw GradleException("truncated tar archive")
                if (header.all { it.toInt() == 0 }) break
                val prefix = field(header, 345, 155)
                val name = field(header, 0, 100).let { if (prefix.isEmpty()) it else "$prefix/$it" }
                val size = field(header, 124, 12).trim().toLong(8)
                val type = header[156].toInt()
                val target = wanted[name]?.takeIf { type == '0'.code || type == 0 }
                var remaining = size
                if (target != null) {
                    target.parentFile.mkdirs()
                    val temp = File(target.parentFile, "${target.name}.tmp")
                    val digest = MessageDigest.getInstance("SHA-256")
                    temp.outputStream().use { output ->
                        copy(BoundedInput(input, size), output::write, digest)
                    }
                    if (!temp.renameTo(target)) throw GradleException("cannot move $temp to $target")
                    found[target] = hex(digest.digest())
                    remaining = 0
                }
                skip(input, remaining + (512 - size % 512) % 512)
            }
        }
        val missing = wanted.filterValues { it !in found }.keys
        if (missing.isNotEmpty()) throw GradleException("missing from archive: $missing")
        return found
    }

    private class BoundedInput(private val input: InputStream, private var left: Long) : InputStream() {
        override fun read(): Int = if (left <= 0) -1 else input.read().also { if (it >= 0) left-- }
        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            if (left <= 0) return -1
            val count = input.read(buffer, offset, minOf(length.toLong(), left).toInt())
            if (count < 0) throw GradleException("truncated tar entry")
            left -= count
            return count
        }
    }

    private fun copy(input: InputStream, write: (ByteArray, Int, Int) -> Unit, digest: MessageDigest) {
        val buffer = ByteArray(1 shl 16)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) return
            digest.update(buffer, 0, count)
            write(buffer, 0, count)
        }
    }

    private fun readFully(input: InputStream, buffer: ByteArray): Boolean {
        var offset = 0
        while (offset < buffer.size) {
            val count = input.read(buffer, offset, buffer.size - offset)
            if (count < 0) return false
            offset += count
        }
        return true
    }

    private fun skip(input: InputStream, bytes: Long) {
        val buffer = ByteArray(1 shl 16)
        var left = bytes
        while (left > 0) {
            val count = input.read(buffer, 0, minOf(buffer.size.toLong(), left).toInt())
            if (count < 0) throw GradleException("truncated tar archive")
            left -= count
        }
    }

    private fun field(header: ByteArray, offset: Int, length: Int): String {
        var end = offset
        while (end < offset + length && header[end].toInt() != 0) end++
        return String(header, offset, end - offset, Charsets.US_ASCII)
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { copy(it, { _, _, _ -> }, digest) }
        return hex(digest.digest())
    }

    private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
}

val fetchPrometheus = tasks.register<FetchPrometheus>("fetchPrometheus") {
    releaseVersion.set(prometheusVersion)
    tarballSha256.set(prometheusTarballSha256)
    binarySha256.set(prometheusBinarySha256)
    cacheDir.set(File(gradle.gradleUserHomeDir, "androdash-cache"))
    jniLibsDir.set(collectorJniLibsDir)
    assetsDir.set(collectorAssetsDir)
}
tasks.named("preBuild") { dependsOn(fetchPrometheus) }

android {
    namespace = "com.mbicz.androdash"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.mbicz.androdash"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        // The bundled Prometheus is linux-arm64 only (decision 0019).
        ndk { abiFilters += "arm64-v8a" }
    }

    packaging {
        jniLibs {
            // Extract libprometheus.so to nativeLibraryDir, where it may be executed.
            useLegacyPackaging = true
            // Ship the verified upstream bytes; never strip the Go binary.
            keepDebugSymbols += "**/libprometheus.so"
        }
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
        getByName("main") {
            assets.srcDirs(
                "$rootDir/web/app",
                dashboardAssetsDir.get().asFile,
                collectorAssetsDir.get().asFile,
            )
            jniLibs.srcDirs(collectorJniLibsDir.get().asFile)
        }
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
