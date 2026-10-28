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
    }

    @Test
    fun `stored dashboard routes are exact`() {
        assertEquals(Route.StoredDashboard, AssetServer.route("/stored/dashboard.json"))
        assertEquals(Route.StoredMeta, AssetServer.route("/stored/meta.json"))
        assertEquals(Route.NotFound, AssetServer.route("/stored/stored.json"))
        assertEquals(Route.NotFound, AssetServer.route("/stored/stored.meta.json"))
        assertEquals(Route.NotFound, AssetServer.route("/stored/"))
        assertEquals(Route.NotFound, AssetServer.route("/stored/dashboard.json/"))
    }

    @Test
    fun `traversal and encoded paths are rejected`() {
        assertEquals(Route.BadPath, AssetServer.route("/dashboards/../index.html"))
        assertEquals(Route.BadPath, AssetServer.route("/dashboards/..json"))
        assertEquals(Route.BadPath, AssetServer.route("/stored/%2e%2e/meta.json"))
        assertEquals(Route.BadPath, AssetServer.route("/dashboards\\x.json"))
        assertEquals(Route.BadPath, AssetServer.route("//stored/dashboard.json"))
    }
}
