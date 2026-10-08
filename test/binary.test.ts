// Exercise the packaged executable from an empty working directory. No Postgres
// is required; TEST_DATABASE_URL adds one read-only query against a test database.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { VERSION } from "../src/version.ts"

const scratch = mkdtempSync(join(tmpdir(), "p2m-binary-"))
const root = resolve(import.meta.dir, "..")
const binary = process.env.P2M_TEST_BINARY
  ? resolve(process.env.P2M_TEST_BINARY)
  : join(scratch, process.platform === "win32" ? "postgres2mcp.exe" : "postgres2mcp")
const database = process.env.TEST_DATABASE_URL ?? "postgres://127.0.0.1:1/unconfigured"
const children = new Set<Bun.Subprocess<"ignore", "pipe", "pipe">>()
const json = async <T>(response: Promise<Response> | Response): Promise<T> => (await (await response).json()) as T
const freshDir = () => mkdtempSync(join(scratch, "run-"))
const env = (cwd: string, extra: Record<string, string> = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    value !== undefined && ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TMP", "TEMP"].includes(key)
  )),
  HOME: cwd,
  ...extra
})
const run = async (args: Array<string>, cwd = freshDir(), extra: Record<string, string> = {}) => {
  const child = Bun.spawn([binary, ...args], { cwd, env: env(cwd, extra), stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
  ])
  return { code, stdout, stderr }
}

beforeAll(async () => {
  if (process.env.P2M_TEST_BINARY) return
  const build = Bun.spawn([process.execPath, "scripts/build-binary.ts", "--outfile", binary], {
    cwd: root, stdout: "pipe", stderr: "pipe"
  })
  const [code, stdout, stderr] = await Promise.all([
    build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()
  ])
  if (code !== 0) throw new Error(`Binary build failed:\n${stdout}\n${stderr}`)
}, 120_000)

afterAll(async () => {
  for (const child of children) { child.kill(); await child.exited }
  rmSync(scratch, { recursive: true, force: true })
})

async function start(cwd: string, args: Array<string> = [], extra: Record<string, string> = {}) {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") })
  const port = String(probe.port)
  await probe.stop(true)
  const child = Bun.spawn([binary, "serve", ...args], {
    cwd,
    env: env(cwd, { DATABASE_URL: database, HOST: "127.0.0.1", PORT: port, P2M_SETUP_TOKEN: "binary-test-code", ...extra }),
    stdin: "ignore", stdout: "pipe", stderr: "pipe"
  })
  children.add(child)
  const stop = async () => { if (!children.has(child)) return; child.kill(); await child.exited; children.delete(child) }
  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 20_000
  for (;;) {
    if (await fetch(`${url}/api/auth/state`).then((r) => r.ok, () => false)) break
    if (child.exitCode !== null || Date.now() > deadline) {
      await stop()
      throw new Error(`Binary did not start:\n${await new Response(child.stdout).text()}\n${await new Response(child.stderr).text()}`)
    }
    await Bun.sleep(50)
  }
  const api = (path: string, body?: unknown, token?: string) => fetch(`${url}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  return { url, api, stop }
}

describe("standalone binary", () => {
  test("help, version, and invalid serve do not write dashboard or state files", async () => {
    const cwd = freshDir()
    const help = await run(["--help"], cwd)
    expect(help.code).toBe(0)
    for (const command of ["serve", "stdio", "reset-password"]) expect(help.stdout).toContain(command)
    expect((await run(["--version"], cwd)).stdout.trim()).toBe(`postgres2mcp v${VERSION}`)
    const missing = await run(["serve"], cwd)
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain("No database to expose")
    expect(readdirSync(cwd)).toEqual([])
  })

  test("embedded dashboard and lazy chunks share canonical module URLs", async () => {
    const cwd = freshDir()
    const state = join(cwd, "selected-state")
    const server = await start(cwd, ["--data-dir", state], { P2M_DATA_DIR: join(cwd, "ignored-state") })
    try {
      const html = await (await fetch(server.url)).text()
      expect(html).toContain("<title>postgres2mcp</title>")
      const entry = /<script[^>]+src="([^"]+)"/.exec(html)?.[1]
      expect(entry).toBeDefined()
      // A query only on the entry makes lazy chunks load a second copy of React.
      const pending = [new URL(entry!, server.url)]
      const seen = new Map<string, string>()
      let importsBackToEntry = 0
      while (pending.length > 0) {
        const url = pending.pop()!
        if (seen.has(url.pathname)) { expect(seen.get(url.pathname)).toBe(url.href); continue }
        seen.set(url.pathname, url.href)
        const response = await fetch(url)
        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toContain("javascript")
        const js = await response.text()
        for (const match of js.matchAll(/(?:from\s*|import\s*\()(["'`])([^"'`]+)\1/g)) {
          const target = match[2]!
          if (!target.startsWith(".") || !target.endsWith(".js")) continue
          const imported = new URL(target, url)
          if (imported.pathname === new URL(entry!, server.url).pathname) importsBackToEntry++
          pending.push(imported)
        }
      }
      expect(importsBackToEntry).toBeGreaterThan(0)
      expect(seen.size).toBeGreaterThan(3)
      for (const asset of html.matchAll(/(?:href|src)="([^"?]+\.(?:css|svg))"/g)) {
        expect((await fetch(new URL(asset[1]!, server.url))).status).toBe(200)
      }
      expect((await fetch(`${server.url}/tools/new`, { headers: { accept: "text/html" } })).status).toBe(200)
      expect((await fetch(`${server.url}/assets/missing.js`)).status).toBe(404)
      expect((await server.api("/no-such-route")).status).toBe(404)
      expect(existsSync(join(state, "postgres2mcp.db"))).toBe(true)
      expect(existsSync(join(state, ".dashboard"))).toBe(true)
      expect(existsSync(join(cwd, "ignored-state"))).toBe(false)
    } finally { await server.stop() }
  })

  test("setup, API keys, MCP, account persistence, and reset-password work", async () => {
    const cwd = freshDir()
    let server = await start(cwd)
    try {
      expect((await json<{ setup_required: boolean }>(server.api("/auth/state"))).setup_required).toBe(true)
      expect((await server.api("/auth/setup", { username: "admin", password: "binary-test-password" })).status).toBe(403)
      const setup = await server.api("/auth/setup", { username: "admin", password: "binary-test-password", setup_code: "binary-test-code" })
      expect(setup.status).toBe(200)
      const { token } = await json<{ token: string }>(setup)
      const keyResponse = await server.api("/keys", { name: "binary-test", groups: ["read"] }, token)
      expect(keyResponse.status).toBe(200)
      const { token: apiKey } = await json<{ token: string }>(keyResponse)
      const rpc = async <T>(method: string, params?: unknown) => {
        const response = await fetch(`${server.url}/mcp`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
        })
        expect(response.status).toBe(200)
        return json<{ result: T }>(response)
      }
      expect((await rpc("ping")).result).toEqual({})
      expect((await rpc<{ tools: Array<{ name: string }> }>("tools/list")).result.tools.map((tool: { name: string }) => tool.name)).toContain("query")
      if (process.env.TEST_DATABASE_URL) {
        const result = await rpc<{ isError: boolean; content: Array<{ text: string }> }>("tools/call", { name: "query", arguments: { sql: "SELECT 1 AS one" } })
        expect(result.result.isError).toBe(false)
        expect(JSON.parse(result.result.content[0]!.text).rows).toEqual([[1]])
      }
      await server.stop()
      const reset = await run(["reset-password", "admin", "--password", "new-binary-password"], cwd)
      expect(reset.code).toBe(0)
      server = await start(cwd)
      expect((await json<{ setup_required: boolean }>(server.api("/auth/state"))).setup_required).toBe(false)
      const login = await server.api("/auth/login", { username: "admin", password: "new-binary-password" })
      expect(login.status).toBe(200)
      const session = (await json<{ token: string }>(login)).token
      const keys = await json<Array<{ name: string }>>(server.api("/keys", undefined, session))
      expect(keys.some((key: { name: string }) => key.name === "binary-test")).toBe(true)
    } finally { await server.stop() }
  })

  test("P2M_WEB_DIR can replace or disable the embedded dashboard", async () => {
    const cwd = freshDir()
    const custom = join(cwd, "custom-web")
    mkdirSync(custom)
    writeFileSync(join(custom, "index.html"), "<!doctype html><title>custom dashboard</title>")
    for (const directory of [custom, join(cwd, "no-dashboard")]) {
      const server = await start(cwd, [], { P2M_WEB_DIR: directory })
      try {
        const html = await (await fetch(server.url)).text()
        expect(html).toContain(directory === custom ? "custom dashboard" : "no dashboard build was found")
        expect(existsSync(join(cwd, "data", ".dashboard"))).toBe(false)
      } finally { await server.stop() }
    }
  })

  test("stdio keeps stdout JSON-only and does not extract the dashboard", async () => {
    const cwd = freshDir()
    const child = Bun.spawn([binary, "stdio", "--database-url", database], {
      cwd, env: env(cwd), stdin: "pipe", stdout: "pipe", stderr: "pipe"
    })
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n')
    child.stdin.end()
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
    expect(code).toBe(0)
    expect(JSON.parse(stdout.trim())).toEqual({ jsonrpc: "2.0", id: 1, result: {} })
    expect(existsSync(join(cwd, "data", "postgres2mcp.db"))).toBe(true)
    expect(existsSync(join(cwd, "data", ".dashboard"))).toBe(false)
  })
})
