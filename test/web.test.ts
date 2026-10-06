// How the server hands out the dashboard, checked against a stand-in build
// directory so the test does not depend on the real one having been built.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ADMIN_PASSWORD, seedDatabase, startServer, type TestServer } from "./harness.ts"

let withWeb: TestServer
let withoutWeb: TestServer
const webDir = mkdtempSync(join(tmpdir(), "p2m-web-"))

beforeAll(async () => {
  mkdirSync(join(webDir, "assets"))
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>dashboard</title>")
  writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')")
  await seedDatabase()
  withWeb = await startServer({ P2M_WEB_DIR: webDir })
  withoutWeb = await startServer()
})

afterAll(async () => {
  await withWeb.stop()
  await withoutWeb.stop()
  rmSync(webDir, { recursive: true, force: true })
})

const html = { accept: "text/html" }

describe("with a dashboard build", () => {
  test("serves the app and its assets", async () => {
    const index = await fetch(`${withWeb.url}/`)
    expect(index.status).toBe(200)
    expect(index.headers.get("content-type")).toContain("text/html")
    expect(await index.text()).toContain("dashboard")

    const asset = await fetch(`${withWeb.url}/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get("content-type")).toContain("javascript")
  })

  test("client-side routes fall back to the app on navigation", async () => {
    for (const path of ["/keys", "/custom-tools/new", "/custom-tools/some_query"]) {
      const response = await fetch(`${withWeb.url}${path}`, { headers: html })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("dashboard")
    }
  })

  test("missing assets are 404s, not the app", async () => {
    expect((await fetch(`${withWeb.url}/assets/missing.js`)).status).toBe(404)
  })

  test("cannot be used to read files outside the build", async () => {
    for (const path of ["/../postgres2mcp.db", "/..%2F..%2Fetc%2Fpasswd", "/%2e%2e/%2e%2e/etc/passwd", "/assets/../../postgres2mcp.db"]) {
      const response = await fetch(`${withWeb.url}${path}`)
      const body = await response.text()
      expect(body).not.toContain("root:")
      expect(body).not.toContain("SQLite format")
      expect(body).not.toContain(ADMIN_PASSWORD)
    }
  })

  test("the API and MCP routes are not shadowed by the app", async () => {
    const api = await fetch(`${withWeb.url}/api/nope`, { headers: html })
    expect(api.status).toBe(404)
    expect(api.headers.get("content-type")).toContain("application/json")
    expect((await fetch(`${withWeb.url}/api/health`)).status).toBe(200)
    expect((await fetch(`${withWeb.url}/mcp`, { headers: html })).status).toBe(405)
    expect((await withWeb.api("GET", "/status")).status).toBe(200)
  })
})

describe("without a dashboard build", () => {
  test("says so, and everything else still works", async () => {
    const index = await fetch(`${withoutWeb.url}/`)
    expect(index.status).toBe(200)
    expect(await index.text()).toContain("no dashboard build was found")
    expect((await withoutWeb.api("GET", "/status")).status).toBe(200)
  })
})
