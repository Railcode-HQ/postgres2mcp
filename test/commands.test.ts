// The binary: `serve`, `stdio` and `reset-password` are all it does
// (`reset-password` is covered with the accounts, in auth.test.ts). The stdio
// transport is driven by the official SDK client.
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BIN, DATABASE_URL, seedDatabase } from "./harness.ts"

beforeAll(async () => {
  await seedDatabase()
})

const bareEnv = (home: string) => ({ PATH: process.env.PATH ?? "", USER: process.env.USER ?? "", HOME: home })

/** Run the binary to completion in a scratch directory. */
const run = async (args: Array<string>, env: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "p2m-run-"))
  const proc = Bun.spawn(["bun", BIN, ...args], { env: { ...bareEnv(dir), ...env }, cwd: dir, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  rmSync(dir, { recursive: true, force: true })
  return { code, stdout, stderr }
}

describe("the binary", () => {
  test("offers serve, stdio and reset-password, and nothing that administers a server", async () => {
    const help = await run(["--help"])
    expect(help.code).toBe(0)
    for (const command of ["serve", "stdio", "reset-password"]) expect(help.stdout).toContain(command)
    for (const gone of ["login", "logout", "setup", "keys", "groups", "logs", "settings"]) {
      expect(help.stdout).not.toContain(gone)
    }
    expect((await run(["--version"])).stdout.trim()).toMatch(/\d+\.\d+\.\d+/)
    expect((await run(["keys", "list"])).code).not.toBe(0)
  })

  test("serve without a database explains what to set", async () => {
    const result = await run(["serve"])
    expect(result.code).toBe(1)
    expect(result.stderr.trim()).toBe(
      "error: No database to expose. Set DATABASE_URL or pass --database-url postgres://user:pass@host:5432/db"
    )
  })

  test("a new server generates a setup code and only its printed link can create the account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p2m-new-"))
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") })
    const port = String(probe.port)
    await probe.stop(true)
    const serve = Bun.spawn(["bun", BIN, "serve"], {
      env: { ...bareEnv(dir), DATABASE_URL, PORT: port, HOST: "127.0.0.1", P2M_WEB_DIR: join(dir, "no-web") },
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe"
    })
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok, () => false)) break
        await Bun.sleep(50)
      }
      expect(existsSync(join(dir, "data", "postgres2mcp.db"))).toBe(true)
      const state = await (await fetch(`http://127.0.0.1:${port}/api/auth/state`)).json()
      expect(state).toMatchObject({ setup_required: true, setup_code_required: true })

      // The banner is printed once the database has answered; read until it is all there.
      const reader = serve.stdout.getReader()
      const decoder = new TextDecoder()
      let banner = ""
      while (!banner.includes("No admin account yet")) {
        const { done, value } = await reader.read()
        if (done) break
        banner += decoder.decode(value)
      }
      expect(banner).toContain("No admin account yet. Create it here:")
      expect(banner).toContain(`http://127.0.0.1:${port}/mcp`)
      const code = /\?setup=([A-Za-z0-9_-]{43})/.exec(banner)?.[1]
      expect(code).toBeDefined()
      const setup = (setup_code?: string) => fetch(`http://127.0.0.1:${port}/api/auth/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "setup-password", setup_code })
      })
      expect((await setup()).status).toBe(403)
      expect((await setup("wrong")).status).toBe(403)
      expect((await setup(code)).status).toBe(200)
    } finally {
      serve.kill()
      await serve.exited
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("a server behind a domain", () => {
  /** Start `serve` with no account and read its banner. */
  const banner = async (env: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "p2m-banner-"))
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") })
    const port = String(probe.port)
    await probe.stop(true)
    const serve = Bun.spawn(["bun", BIN, "serve"], {
      env: { ...bareEnv(dir), DATABASE_URL, PORT: port, HOST: "127.0.0.1", P2M_WEB_DIR: join(dir, "no-web"), ...env },
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe"
    })
    try {
      const reader = serve.stdout.getReader()
      const decoder = new TextDecoder()
      let text = ""
      while (!text.includes("No admin account yet")) {
        const { done, value } = await reader.read()
        if (done) break
        text += decoder.decode(value)
      }
      // The lines after "No admin account yet" arrive in the same write.
      const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()
      return { text, health }
    } finally {
      serve.kill()
      await serve.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test("prints its public address and a one-time link that creates the account", async () => {
    const { text, health } = await banner({ P2M_PUBLIC_URL: "https://mcp.example.com/", P2M_SETUP_TOKEN: "abc 123" })
    // (No dashboard build in this test, so only the MCP line carries the address.)
    expect(text).toContain("MCP          https://mcp.example.com/mcp")
    expect(text).toContain("No admin account yet. Create it here:")
    expect(text).toContain("https://mcp.example.com/?setup=abc%20123")
    expect(text).not.toContain("The first person to open the dashboard")
    // Anyone may ask whether the server is up and its database answers; that is all it says.
    expect(health).toEqual({ ok: true, version: expect.stringMatching(/^\d+\.\d+\.\d+$/), database: true })
  })

  test("starts without its database, and health says the database does not answer", async () => {
    const { text, health } = await banner({ DATABASE_URL: "postgres://127.0.0.1:1/nowhere" })
    expect(text).toContain("NOT CONNECTED")
    expect(health).toMatchObject({ ok: true, database: false })
  })

  test("refuses a public address that is not a URL", async () => {
    const result = await run(["serve"], { DATABASE_URL, P2M_PUBLIC_URL: "mcp.example.com" })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("P2M_PUBLIC_URL must be an http(s) URL")
  })
})

describe("stdio transport", () => {
  const connect = async (...extra: Array<string>) => {
    const dataDir = mkdtempSync(join(tmpdir(), "p2m-stdio-"))
    const client = new Client({ name: "stdio-test", version: "1.0.0" })
    let listChanges = 0
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      listChanges++
    })
    const transport = new StdioClientTransport({
      command: "bun",
      args: [BIN, "stdio", "--database-url", DATABASE_URL, "--data-dir", dataDir, ...extra],
      env: bareEnv(dataDir),
      stderr: "pipe"
    })
    await client.connect(transport as Transport)
    return {
      client,
      dataDir,
      listChanges: () => listChanges,
      close: async () => {
        await client.close()
        rmSync(dataDir, { recursive: true, force: true })
      }
    }
  }

  test("defaults to read-only exploration", async () => {
    const { client, close } = await connect()
    expect(client.getServerVersion()).toMatchObject({ name: "postgres2mcp" })
    expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: false } })
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).toEqual([
      "list_schemas",
      "list_tables",
      "describe_table",
      "list_relationships",
      "search_schema",
      "query",
      "explain_query"
    ])
    const result: any = await client.callTool({ name: "query", arguments: { sql: "SELECT count(*) AS n FROM customers" } })
    expect(JSON.parse(result.content[0].text)).toEqual({ columns: ["n"], rows: [[20]], row_count: 1 })
    const refused: any = await client.callTool({ name: "query", arguments: { sql: "DELETE FROM scratch" } })
    expect(refused.isError).toBe(true)
    await expect(client.callTool({ name: "execute_sql", arguments: { sql: "SELECT 1" } })).rejects.toThrow("Unknown tool")
    await expect(client.callTool({ name: "create_custom_tool", arguments: { name: "x", sql: "SELECT 1" } }))
      .rejects.toThrow("Unknown tool")
    await close()
  })

  test("--format chooses how rows are written", async () => {
    const { client, close } = await connect("--format", "markdown")
    const result: any = await client.callTool({ name: "query", arguments: { sql: "SELECT 1 AS one, 'a' AS letter" } })
    expect(result.content[0].text).toBe("| one | letter |\n| --- | --- |\n| 1 | a |\n\n1 row")
    await close()
  })

  test("COPY returns a tool error and stdio keeps accepting requests", async () => {
    const { client, close } = await connect()
    try {
      const result: any = await client.callTool({ name: "query", arguments: { sql: "COPY (SELECT 1) TO STDOUT" } })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain("COPY is not supported")
      await client.ping()
      const next: any = await client.callTool({ name: "query", arguments: { sql: "SELECT 1 AS ok" } })
      expect(JSON.parse(next.content[0].text).rows).toEqual([[1]])
    } finally {
      await close()
    }
  })

  test("--groups widens what is exposed", async () => {
    const { client, close } = await connect("--groups", "all")
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).toContain("execute_sql")
    expect(names).toContain("drop_table")
    expect(names).toContain("create_custom_tool")
    await close()
  })

  test("with the authoring group, a client writes a tool, is told the list changed, and calls it", async () => {
    const { client, close, listChanges } = await connect("--groups", "schema,custom,authoring")
    expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: true } })
    expect(client.getInstructions()).toContain("create_custom_tool")

    const created: any = await client.callTool({
      name: "create_custom_tool",
      arguments: {
        name: "customer_count",
        description: "How many customers there are",
        sql: "SELECT count(*)::int AS n FROM customers WHERE id <= :max",
        params: [{ name: "max", type: "int", default: 1000 }]
      }
    })
    expect(created.isError).toBe(false)
    expect(JSON.parse(created.content[0].text)).toMatchObject({ name: "customer_count", version: 1 })
    await Bun.sleep(20)
    expect(listChanges()).toBe(1)

    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("customer_count")
    const counted: any = await client.callTool({ name: "customer_count", arguments: { max: 5 } })
    expect(JSON.parse(counted.content[0].text)).toEqual({ columns: ["n"], rows: [[5]], row_count: 1 })

    // A read-only call changes nothing, so says nothing.
    await client.callTool({ name: "list_custom_tools", arguments: {} })
    await Bun.sleep(20)
    expect(listChanges()).toBe(1)
    await close()
  })

  test("stdout carries only protocol messages", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "p2m-stdio-"))
    const proc = Bun.spawn(["bun", BIN, "stdio", "-d", DATABASE_URL, "--data-dir", dataDir, "--groups", "read,authoring"], {
      env: bareEnv(dataDir),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    })
    proc.stdin.write([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      "this is not json",
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "query", arguments: { sql: "SELECT 1 AS one" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_custom_tool", arguments: { name: "one", sql: "SELECT 1" } } }),
      ""
    ].join("\n"))
    proc.stdin.end()
    const lines = (await new Response(proc.stdout).text()).trim().split("\n").map((line) => JSON.parse(line))
    expect(await proc.exited).toBe(0)
    // The answer to a call that changed the tool list is followed by the notification.
    expect(lines.map((line) => "id" in line ? line.id : line.method)).toEqual([1, null, 2, 3, "notifications/tools/list_changed"])
    expect(lines[1].error.code).toBe(-32700)
    expect(lines[2].result.isError).toBe(false)
    expect(lines[3].result.isError).toBe(false)
    rmSync(dataDir, { recursive: true, force: true })
  })
})
