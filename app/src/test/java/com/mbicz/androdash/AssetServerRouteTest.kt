package com.mbicz.androdash

import com.mbicz.androdash.AssetServer.Route
import org.junit.Assert.assertEquals
import org.junit.Test

class AssetServerRouteTest {
    @Test
    fun `renderer assets keep their allow-list`() {
        assertEquals(Route.Asset("index.html"), AssetServer.route(""))
        assertEquals(Route.Asset("index.html"), AssetServer.route("/"))
        assertEquals(Route.Asset("index.html"), AssetServer.route("/index.html"))
        assertEquals(Route.Asset("styles.css"), AssetServer.route("/styles.css"))
        assertEquals(Route.Asset("src/render/chart.js"), AssetServer.route("/src/render/chart.js"))
        assertEquals(Route.NotFound, AssetServer.route("/src/render/chart.ts"))
        assertEquals(Route.NotFound, AssetServer.route("/AndroidManifest.xml"))
    }

    @Test
    fun `bundled dashboards are served from the dashboards directory only`() {
        assertEquals(
            Route.Asset("dashboards/macos-node-dashboard.json"),
            AssetServer.route("/dashboards/macos-node-dashboard.json"),
        )
        assertEquals(Route.Asset("dashboards/a.b_c-1.json"), AssetServer.route("/dashboards/a.b_c-1.json"))
        assertEquals(Route.NotFound, AssetServer.route("/dashboards/sub/x.json"))
        assertEquals(Route.NotFound, AssetServer.route("/dashboards/x.js"))
        assertEquals(Route.NotFound, AssetServer.route("/dashboards/.json"))
        assertEquals(Route.NotFound, AssetServer.route("/dashboards/"))
        assertEquals(Route.NotFound, AssetServer.route("/contracts/fixtures/demo-dashboard.json"))
        // The generated bundled-dashboard index rides on the same allow-list.
        assertEquals(Route.Asset("dashboards/index.json"), AssetServer.route("/dashboards/index.json"))
    }

    @Test
    fun `stored dashboard slot routes are exact`() {
        for (slot in 0..7) {
            assertEquals(Route.StoredDashboard(slot), AssetServer.route("/stored/$slot/dashboard.json"))
            assertEquals(Route.StoredMeta(slot), AssetServer.route("/stored/$slot/meta.json"))
        }
        listOf(
            "/stored/8/dashboard.json",
            "/stored/9/meta.json",
            "/stored/00/dashboard.json",
            "/stored/-1/dashboard.json",
            "/stored/a/dashboard.json",
            "/stored/0/stored.json",
            "/stored/0/dashboard.json/",
            "/stored/0/",
            "/stored/0",
            // The pre-slot single-copy routes are gone.
            "/stored/dashboard.json",
            "/stored/meta.json",
            "/stored/stored.json",
            "/stored/stored.meta.json",
            "/stored/",
        ).forEach { assertEquals(it, Route.NotFound, AssetServer.route(it)) }
    }

    @Test
    fun `inline dashboard routes take a 16 hex character id only`() {
        assertEquals(Route.Inline("0123456789abcdef"), AssetServer.route("/inline/0123456789abcdef.json"))
        listOf(
            "/inline/0123456789ABCDEF.json",
            "/inline/0123456789abcde.json",
            "/inline/0123456789abcdef0.json",
            "/inline/0123456789abcdeg.json",
            "/inline/0123456789abcdef.js",
            "/inline/0123456789abcdef.json/",
            "/inline/sub/0123456789abcdef.json",
            "/inline/",
            "/inline",
        ).forEach { assertEquals(it, Route.NotFound, AssetServer.route(it)) }
        assertEquals(Route.BadPath, AssetServer.route("/inline/../stored/0/dashboard.json"))
        assertEquals(Route.BadPath, AssetServer.route("/inline/%30123456789abcdef.json"))
    }

    @Test
    fun `traversal and encoded paths are rejected`() {
        assertEquals(Route.BadPath, AssetServer.route("/dashboards/../index.html"))
        assertEquals(Route.BadPath, AssetServer.route("/dashboards/..json"))
        assertEquals(Route.BadPath, AssetServer.route("/stored/%2e%2e/meta.json"))
        assertEquals(Route.BadPath, AssetServer.route("/dashboards\\x.json"))
        assertEquals(Route.BadPath, AssetServer.route("//stored/0/dashboard.json"))
        assertEquals(Route.BadPath, AssetServer.route("/stored/0/../meta.json"))
        assertEquals(Route.BadPath, AssetServer.route("/stored/%30/meta.json"))
    }
}
