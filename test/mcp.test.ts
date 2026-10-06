// The MCP surface: exercised with the official SDK client over streamable
// HTTP (what real clients speak), plus raw JSON-RPC for the edges.
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { direct, seedDatabase, startServer, type TestServer } from "./harness.ts"

let server: TestServer
const tokens: Record<string, string> = {}
const ids: Record<string, string> = {}

const createKey = async (name: string, grants: { groups?: Array<string>; tools?: Array<string> }) => {
  const { body } = await server.api("POST", "/keys", { name, ...grants })
  tokens[name] = body.token
  ids[name] = body.key.id
}

const connect = async (token: string) => {
  const client = new Client({ name: "postgres2mcp-tests", version: "1.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } }
  })
  // The SDK's own types disagree under exactOptionalPropertyTypes.
  await client.connect(transport as Transport)
  return client
}

const textOf = (result: any): string => result.content[0].text

beforeAll(async () => {
  await seedDatabase()
  server = await startServer()
  await server.api("POST", "/custom-tools", {
    name: "orders_by_status",
    description: "Orders in a status, oldest first",
    sql: "SELECT id, total FROM orders WHERE status = :status::order_status ORDER BY id LIMIT :limit",
    params: [
      { name: "status", type: "string", description: "pending, paid or shipped" },
      { name: "limit", type: "int", default: 2 }
    ]
  })
  await server.api("POST", "/custom-tools", {
    name: "add_note",
    sql: "INSERT INTO scratch (note) VALUES (:note) RETURNING id",
    allow_writes: true
  })
  await server.api("POST", "/groups", { id: "support", tools: ["orders_by_status", "list_tables"] })
  await createKey("reader", { groups: ["schema", "read"] })
  await createKey("support", { groups: ["support"] })
  await createKey("writer", { groups: ["read", "write"], tools: ["add_note"] })
  await createKey("admin", { groups: ["all"] })
  await createKey("nothing", {})
  await createKey("author", { groups: ["authoring", "custom"] })
  await createKey("author-writer", { groups: ["authoring", "custom", "write"] })
  await createKey("author-only", { groups: ["authoring"] })
})

afterAll(async () => {
  await server.stop()
})

describe("handshake", () => {
  test("initializes and describes the server", async () => {
    const client = await connect(tokens.reader!)
    expect(client.getServerVersion()).toMatchObject({ name: "postgres2mcp" })
    expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: false } })
    expect(client.getInstructions()).toContain("postgres2mcp_test")
    expect(client.getInstructions()).toContain("list_tables")
    await client.ping()
    await client.close()
  })

  test("negotiates the protocol version", async () => {
    const init = (protocolVersion: string) =>
      server.rpc(tokens.reader!, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion, capabilities: {}, clientInfo: { name: "raw", version: "0" } }
      })
    expect((await init("2025-03-26")).body.result.protocolVersion).toBe("2025-03-26")
    expect((await init("2024-11-05")).body.result.protocolVersion).toBe("2024-11-05")
    // A version we do not know: answer with the newest we do.
    expect((await init("1999-01-01")).body.result.protocolVersion).toBe("2025-11-25")
  })

  test("instructions mention custom tools only to keys that have them", async () => {
    const support = await connect(tokens.support!)
    expect(support.getInstructions()).toContain("orders_by_status")
    await support.close()
    const reader = await connect(tokens.reader!)
    expect(reader.getInstructions()).not.toContain("orders_by_status")
    await reader.close()
  })
})

describe("tools/list is scoped to the key", () => {
  const namesFor = async (key: string) => {
    const client = await connect(tokens[key]!)
    const { tools } = await client.listTools()
    await client.close()
    return tools.map((tool) => tool.name)
  }

  test("each key sees exactly its grants", async () => {
    expect(await namesFor("reader")).toEqual([
      "list_schemas",
      "list_tables",
      "describe_table",
      "list_relationships",
      "search_schema",
      "query",
      "explain_query"
    ])
    expect(await namesFor("support")).toEqual(["list_tables", "orders_by_status"])
    expect(await namesFor("writer")).toEqual(["query", "explain_query", "execute_sql", "add_note"])
    expect(await namesFor("nothing")).toEqual([])
    expect(await namesFor("author-only")).toEqual([
      "list_custom_tools",
      "test_custom_tool",
      "create_custom_tool",
      "update_custom_tool",
      "delete_custom_tool"
    ])
    // 21 built-in tools and the two custom ones.
    expect((await namesFor("admin")).length).toBe(23)
  })

  test("tools carry schemas and safety annotations", async () => {
    const client = await connect(tokens.admin!)
    const { tools } = await client.listTools()
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))

    expect(byName.orders_by_status).toMatchObject({
      description: "Orders in a status, oldest first",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", description: "pending, paid or shipped" },
          limit: { type: "integer", default: 2 }
        },
        required: ["status"]
      },
      annotations: { readOnlyHint: true, destructiveHint: false }
    })
    expect(byName.query!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    // Anything that can write is flagged destructive, except the two admin
    // tools that cannot lose data.
    expect(byName.execute_sql!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    expect(byName.add_note!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    expect(byName.drop_table!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    expect(byName.truncate_table!.annotations).toMatchObject({ destructiveHint: true })
    expect(byName.vacuum_analyze!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    expect(byName.cancel_query!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    expect(byName.list_schemas!.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: false })
    for (const tool of tools) expect(tool.inputSchema.type).toBe("object")
    await client.close()
  })

  test("a custom tool added later shows up without reconnecting", async () => {
    const client = await connect(tokens.admin!)
    await server.api("POST", "/custom-tools", { name: "fresh", sql: "SELECT 1 AS one" })
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("fresh")
    expect(textOf(await client.callTool({ name: "fresh", arguments: {} }))).toBe(
      "{\"columns\":[\"one\"],\"rows\":[[1]],\"row_count\":1}"
    )
    await server.api("DELETE", "/custom-tools/fresh")
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("fresh")
    await client.close()
  })
})

describe("tools/call", () => {
  test("a read-only COPY request fails without taking down the HTTP server", async () => {
    const client = await connect(tokens.reader!)
    try {
      const result = await client.callTool({ name: "query", arguments: { sql: "COPY (SELECT 1) TO STDOUT" } })
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain("COPY is not supported")
      await client.ping()
      const next = await client.callTool({ name: "query", arguments: { sql: "SELECT 1 AS ok" } })
      expect(JSON.parse(textOf(next)).rows).toEqual([[1]])
      expect((await server.api("GET", "/health", undefined, "")).status).toBe(200)
    } finally {
      await client.close()
    }
  })

  test("built-in tools answer with JSON text", async () => {
    const client = await connect(tokens.reader!)
    // A list of rows, so it is written in the result format (compact by default).
    const tables = await client.callTool({ name: "list_tables", arguments: { schema: "billing" } })
    expect(tables.isError).toBe(false)
    const listed = JSON.parse(textOf(tables))
    expect(listed.columns).toEqual(["schema", "name", "type", "estimated_rows", "size", "comment"])
    expect(listed.rows.map((row: any) => row[1])).toEqual(["invoices"])

    // A single document, so it is JSON whatever the format.
    const described = await client.callTool({ name: "describe_table", arguments: { table: "orders" } })
    expect(JSON.parse(textOf(described)).primary_key).toEqual(["id"])

    const rows = await client.callTool({
      name: "query",
      arguments: { sql: "SELECT id FROM customers WHERE id <= $1 ORDER BY id", params: [2] }
    })
    expect(JSON.parse(textOf(rows))).toEqual({ columns: ["id"], rows: [[1], [2]], row_count: 2 })
    await client.close()
  })

  test("custom tools bind params and defaults", async () => {
    const client = await connect(tokens.support!)
    const result = await client.callTool({ name: "orders_by_status", arguments: { status: "paid" } })
    expect(JSON.parse(textOf(result))).toEqual({ columns: ["id", "total"], rows: [[1, 1.5], [4, 6]], row_count: 2 })
    const one = await client.callTool({ name: "orders_by_status", arguments: { status: "paid", limit: 1 } })
    expect(JSON.parse(textOf(one)).row_count).toBe(1)
    await client.close()
  })

  test("tool failures come back in-band so the model can recover", async () => {
    const client = await connect(tokens.admin!)
    const sqlError = await client.callTool({ name: "query", arguments: { sql: "SELECT * FROM nowhere" } })
    expect(sqlError.isError).toBe(true)
    expect(textOf(sqlError)).toContain("relation \"nowhere\" does not exist")
    expect(textOf(sqlError)).toContain("Position: 15")

    const missing = await client.callTool({ name: "orders_by_status", arguments: {} })
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toBe("Missing param \"status\" (expected a string)")

    const mistyped = await client.callTool({ name: "orders_by_status", arguments: { status: "paid", limit: "many" } })
    expect(textOf(mistyped)).toBe("Param \"limit\" must be an integer")

    const badArgs = await client.callTool({ name: "describe_table", arguments: {} })
    expect(badArgs.isError).toBe(true)
    expect(textOf(badArgs)).toContain("Invalid arguments")

    const readOnly = await client.callTool({ name: "query", arguments: { sql: "DELETE FROM scratch" } })
    expect(readOnly.isError).toBe(true)
    expect(textOf(readOnly)).toContain("read-only transaction")
    expect(textOf(readOnly)).toContain("Hint:")
    await client.close()
  })

  test("a key cannot call what it was not granted", async () => {
    const reader = await connect(tokens.reader!)
    for (const name of ["execute_sql", "drop_table", "truncate_table", "orders_by_status", "add_note", "database_stats"]) {
      await expect(reader.callTool({ name, arguments: {} })).rejects.toThrow(`Unknown tool: ${name}`)
    }
    await reader.close()

    const support = await connect(tokens.support!)
    await expect(support.callTool({ name: "query", arguments: { sql: "SELECT 1" } })).rejects.toThrow("Unknown tool")
    await support.close()

    const nothing = await connect(tokens.nothing!)
    await expect(nothing.callTool({ name: "list_tables", arguments: {} })).rejects.toThrow("Unknown tool")
    await nothing.close()
  })

  test("a denied call never reaches the database", async () => {
    const reader = await connect(tokens.reader!)
    await expect(reader.callTool({ name: "drop_table", arguments: { table: "scratch" } })).rejects.toThrow()
    await expect(reader.callTool({ name: "execute_sql", arguments: { sql: "DELETE FROM scratch" } })).rejects.toThrow()
    await reader.close()
    expect(await direct("SELECT count(*)::int AS n FROM scratch")).toEqual([{ n: 3 }])
  })

  test("a tool that truly does not exist reads the same as a denied one", async () => {
    const client = await connect(tokens.reader!)
    await expect(client.callTool({ name: "no_such_tool", arguments: {} })).rejects.toThrow("Unknown tool: no_such_tool")
    await client.close()
  })

  test("write access is what the key was given, nothing more", async () => {
    const writer = await connect(tokens.writer!)
    const inserted = await writer.callTool({ name: "add_note", arguments: { note: "from-mcp" } })
    expect(inserted.isError).toBe(false)
    const updated = await writer.callTool({
      name: "execute_sql",
      arguments: { sql: "UPDATE scratch SET note = 'changed' WHERE note = 'from-mcp'" }
    })
    expect(JSON.parse(textOf(updated))).toEqual({ command: "UPDATE", row_count: 1 })
    expect(await direct("SELECT count(*)::int AS n FROM scratch WHERE note = 'changed'")).toEqual([{ n: 1 }])
    // Even with write access, `query` stays read-only.
    const viaQuery = await writer.callTool({ name: "query", arguments: { sql: "DELETE FROM scratch" } })
    expect(viaQuery.isError).toBe(true)
    await expect(writer.callTool({ name: "truncate_table", arguments: { table: "scratch" } })).rejects.toThrow()
    await writer.close()
    await direct("DELETE FROM scratch WHERE note = 'changed'")
  })

  test("admin tools work for a key that holds them", async () => {
    await direct("CREATE TABLE mcp_doomed (id int); INSERT INTO mcp_doomed VALUES (1), (2)")
    const admin = await connect(tokens.admin!)
    const truncated = await admin.callTool({ name: "truncate_table", arguments: { table: "mcp_doomed" } })
    expect(JSON.parse(textOf(truncated))).toEqual({ ok: true, truncated: "public.mcp_doomed" })
    expect(await direct("SELECT count(*)::int AS n FROM mcp_doomed")).toEqual([{ n: 0 }])
    const dropped = await admin.callTool({ name: "drop_table", arguments: { table: "mcp_doomed" } })
    expect(dropped.isError).toBe(false)
    expect(await direct("SELECT to_regclass('public.mcp_doomed') AS t")).toEqual([{ t: null }])
    await admin.close()
  })
})

describe("authoring tools", () => {
  const AUTHORING = ["list_custom_tools", "test_custom_tool", "create_custom_tool", "update_custom_tool", "delete_custom_tool"]

  /** A client that counts the list-changed notifications it is sent. */
  const author = async (key = "author") => {
    const client = await connect(tokens[key]!)
    let listChanges = 0
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      listChanges++
    })
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result: any = await client.callTool({ name, arguments: args })
      // Notifications ride ahead of the answer; let their handlers run.
      await Bun.sleep(5)
      return result
    }
    return { client, call, listChanges: () => listChanges }
  }
  const json = (result: any) => JSON.parse(textOf(result))
  const stored = async () => (await server.api("GET", "/custom-tools")).body.map((tool: any) => tool.name)

  test("are invisible to a key without the group", async () => {
    const reader = await connect(tokens.reader!)
    for (const name of AUTHORING) {
      await expect(reader.callTool({ name, arguments: { name: "x", sql: "SELECT 1" } })).rejects.toThrow(`Unknown tool: ${name}`)
    }
    await reader.close()
    expect(await stored()).not.toContain("x")
  })

  test("only a key that can change the tool list is promised news of it", async () => {
    const { client } = await author()
    expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: true } })
    expect(client.getInstructions()).toContain("create_custom_tool")
    await client.close()
    // `reader` is checked in the handshake tests: listChanged is false there.
  })

  test("carry the hints a client needs to ask before changing things", async () => {
    const { client } = await author()
    const byName = Object.fromEntries((await client.listTools()).tools.map((tool) => [tool.name, tool]))
    expect(byName.list_custom_tools!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    expect(byName.test_custom_tool!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    expect(byName.create_custom_tool!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    expect(byName.update_custom_tool!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    expect(byName.delete_custom_tool!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    expect(byName.create_custom_tool!.inputSchema).toMatchObject({
      required: ["name", "sql"],
      additionalProperties: false,
      properties: {
        params: {
          type: "array",
          items: {
            required: ["name", "type"],
            additionalProperties: false,
            properties: { type: { enum: ["string", "int", "float", "bool"] } }
          }
        }
      }
    })
    await client.close()
  })

  test("a draft is tested without being saved, and only ever read-only", async () => {
    const { call, client, listChanges } = await author()
    const sql = "SELECT count(*)::int AS n FROM orders WHERE status = :status::order_status"
    expect(json(await call("test_custom_tool", { sql, args: { status: "paid" } }))).toEqual({
      columns: ["n"],
      rows: [[100]],
      row_count: 1
    })
    const typed = await call("test_custom_tool", {
      sql: "SELECT :n * 2 AS doubled",
      params: [{ name: "n", type: "int" }],
      args: { n: 21 }
    })
    expect(json(typed).rows).toEqual([[42]])

    const missing = await call("test_custom_tool", { sql })
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toBe("Missing param \"status\" (expected a string)")
    const undeclared = await call("test_custom_tool", { sql: "SELECT :a", params: [] })
    expect(textOf(undeclared)).toBe("Placeholder \":a\" is not a declared param")

    const write = await call("test_custom_tool", { sql: "DELETE FROM scratch" })
    expect(write.isError).toBe(true)
    expect(textOf(write)).toContain("read-only transaction")
    expect(await direct("SELECT count(*)::int AS n FROM scratch")).toEqual([{ n: 3 }])

    expect(listChanges()).toBe(0)
    expect(await stored()).not.toContain("draft")
    await client.close()
  })

  test("create, call, update and delete — with the list-changed notice each time", async () => {
    const { call, client, listChanges } = await author()
    const created = await call("create_custom_tool", {
      name: "orders_in_status",
      description: "How many orders are in a status",
      sql: "SELECT count(*)::int AS n FROM orders WHERE status = :status::order_status",
      params: [{ name: "status", type: "string", description: "pending, paid or shipped" }]
    })
    expect(created.isError).toBe(false)
    expect(json(created)).toEqual({
      name: "orders_in_status",
      description: "How many orders are in a status",
      sql: "SELECT count(*)::int AS n FROM orders WHERE status = :status::order_status",
      params: [{ name: "status", type: "string", description: "pending, paid or shipped" }],
      allow_writes: false,
      version: 1,
      groups: [],
      note: "Saved as version 1. List tools again to see it, then call it by name."
    })
    expect(listChanges()).toBe(1)

    // It is a tool like any other now, for this key and for the dashboard.
    const listed = (await client.listTools()).tools.find((tool) => tool.name === "orders_in_status")
    expect(listed).toMatchObject({
      description: "How many orders are in a status",
      inputSchema: { properties: { status: { type: "string", description: "pending, paid or shipped" } }, required: ["status"] },
      annotations: { readOnlyHint: true }
    })
    expect(json(await call("orders_in_status", { status: "shipped" }))).toEqual({ columns: ["n"], rows: [[100]], row_count: 1 })
    expect((await server.api("GET", "/custom-tools/orders_in_status")).body).toMatchObject({ version: 1, allow_writes: false })

    // Params are derived when left out, keeping declarations that still apply.
    const updated = await call("update_custom_tool", {
      name: "orders_in_status",
      sql: "SELECT count(*)::int AS n FROM orders WHERE status = :status::order_status AND total >= :min_total::numeric"
    })
    expect(json(updated)).toMatchObject({
      version: 2,
      description: "How many orders are in a status",
      params: [
        { name: "status", type: "string", description: "pending, paid or shipped" },
        { name: "min_total", type: "string" }
      ]
    })
    expect(listChanges()).toBe(2)
    expect(json(await call("orders_in_status", { status: "paid", min_total: "400" })).rows).toEqual([[11]])

    const one = await call("list_custom_tools", { name: "orders_in_status" })
    expect(json(one)).toMatchObject({ name: "orders_in_status", version: 2 })
    const all = json(await call("list_custom_tools")).tools
    expect(all.map((tool: any) => tool.name)).toEqual(["add_note", "orders_by_status", "orders_in_status"])
    expect(all.find((tool: any) => tool.name === "orders_by_status")).toMatchObject({ groups: ["support"], version: 1 })
    expect(listChanges()).toBe(2)

    expect(json(await call("delete_custom_tool", { name: "orders_in_status" }))).toEqual({ ok: true, deleted: "orders_in_status" })
    expect(listChanges()).toBe(3)
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("orders_in_status")
    await expect(client.callTool({ name: "orders_in_status", arguments: { status: "paid" } })).rejects.toThrow("Unknown tool")
    expect(await stored()).not.toContain("orders_in_status")
    await client.close()
  })

  test("mistakes come back in-band and change nothing", async () => {
    const { call, client, listChanges } = await author()
    const failure = async (name: string, args: Record<string, unknown>) => {
      const result = await call(name, args)
      expect(result.isError).toBe(true)
      return textOf(result)
    }
    const before = await stored()
    expect(await failure("create_custom_tool", { name: "Bad-Name", sql: "SELECT 1" })).toContain("Tool name must")
    expect(await failure("create_custom_tool", { name: "query", sql: "SELECT 1" })).toContain("built-in tool")
    expect(await failure("create_custom_tool", { name: "create_custom_tool", sql: "SELECT 1" })).toContain("built-in tool")
    expect(await failure("create_custom_tool", { name: "orders_by_status", sql: "SELECT 1" })).toContain("already exists")
    expect(await failure("create_custom_tool", { name: "t1", sql: "SELECT 1; SELECT 2" })).toContain("single SQL statement")
    expect(await failure("create_custom_tool", { name: "t1", sql: "SELECT :a", params: [] }))
      .toBe("Placeholder \":a\" is not a declared param")
    expect(await failure("create_custom_tool", { name: "t1", sql: "SELECT :a", params: [{ name: "a", type: "date" }] }))
      .toContain("Invalid arguments")
    // Who may call a tool is not for an MCP client to say.
    expect(await failure("create_custom_tool", { name: "t1", sql: "SELECT 1", groups: ["support"] })).toContain("Invalid arguments")
    expect(await failure("update_custom_tool", { name: "nope", description: "x" }))
      .toBe("No custom tool \"nope\". Use list_custom_tools to see what exists.")
    expect(await failure("update_custom_tool", { name: "orders_by_status", params: [] }))
      .toBe("Placeholder \":status\" is not a declared param")
    expect(await failure("delete_custom_tool", { name: "nope" })).toContain("No custom tool \"nope\"")
    expect(await failure("list_custom_tools", { name: "nope" })).toContain("No custom tool \"nope\"")
    expect(await stored()).toEqual(before)
    expect(listChanges()).toBe(0)
    await client.close()
  })

  test("a key cannot author a tool that writes unless it could already write", async () => {
    const plain = await author("author")
    const refused = await plain.call("create_custom_tool", {
      name: "note_writer",
      sql: "INSERT INTO scratch (note) VALUES (:note)",
      allow_writes: true
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain("can only be authored by a caller that holds execute_sql")
    expect(await stored()).not.toContain("note_writer")

    // Read-only is the default, and Postgres holds it to that.
    expect((await plain.call("create_custom_tool", { name: "note_writer", sql: "INSERT INTO scratch (note) VALUES (:note)" })).isError)
      .toBe(false)
    expect(textOf(await plain.call("note_writer", { note: "nope" }))).toContain("read-only transaction")
    expect(textOf(await plain.call("update_custom_tool", { name: "note_writer", allow_writes: true })))
      .toContain("holds execute_sql")
    // Nor may it rewrite a tool that already writes.
    expect(textOf(await plain.call("update_custom_tool", { name: "add_note", sql: "DELETE FROM scratch WHERE note = :note" })))
      .toContain("holds execute_sql")
    expect((await server.api("GET", "/custom-tools/add_note")).body.sql).toContain("INSERT INTO scratch")

    const writer = await author("author-writer")
    const enabled = await writer.call("update_custom_tool", { name: "note_writer", allow_writes: true })
    expect(json(enabled)).toMatchObject({ allow_writes: true, version: 2 })
    expect(json(await writer.call("note_writer", { note: "authored" }))).toEqual({ command: "INSERT", row_count: 1 })
    expect(await direct("SELECT count(*)::int AS n FROM scratch WHERE note = 'authored'")).toEqual([{ n: 1 }])

    // Taking the write away is not minting anything.
    expect(json(await plain.call("update_custom_tool", { name: "note_writer", allow_writes: false }))).toMatchObject({
      allow_writes: false,
      version: 3
    })
    await plain.call("delete_custom_tool", { name: "note_writer" })
    await direct("DELETE FROM scratch WHERE note = 'authored'")
    await plain.client.close()
    await writer.client.close()
  })

  test("writing a tool is not being able to call it", async () => {
    const { call, client } = await author("author-only")
    const created = await call("create_custom_tool", { name: "for_others", sql: "SELECT 1 AS one" })
    expect(json(created).note).toContain("you cannot call it")
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(AUTHORING)
    await expect(client.callTool({ name: "for_others", arguments: {} })).rejects.toThrow("Unknown tool")
    // A key with the custom group gets it at once.
    const support = await connect(tokens.author!)
    expect(textOf(await support.callTool({ name: "for_others", arguments: {} }))).toContain("\"rows\":[[1]]")
    await support.close()
    await client.close()
  })

  test("deleting over MCP strips the grants that named the tool", async () => {
    await server.api("POST", "/groups", { id: "others", tools: ["for_others", "list_tables"] })
    const key = (await server.api("POST", "/keys", { name: "named", tools: ["for_others"] })).body.key
    const { call, client } = await author("author-only")
    expect((await call("delete_custom_tool", { name: "for_others" })).isError).toBe(false)
    expect((await server.api("GET", "/keys")).body.find((candidate: any) => candidate.id === key.id).tools).toEqual([])
    expect((await server.api("GET", "/groups")).body.find((group: any) => group.id === "others").tools).toEqual(["list_tables"])
    await server.api("DELETE", "/groups/others")
    await server.api("DELETE", `/keys/${key.id}`)
    await client.close()
  })

  test("the notice travels as an event stream only to a client that accepts one", async () => {
    const post = (accept: string, id: number, name: string) =>
      fetch(`${server.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept, authorization: `Bearer ${tokens.author}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: name === "create_custom_tool" ? { name: "raw_one", sql: "SELECT 1" } : { name: "raw_one" } }
        })
      })

    const streamed = await post("application/json, text/event-stream", 7, "create_custom_tool")
    expect(streamed.headers.get("content-type")).toContain("text/event-stream")
    const events = (await streamed.text()).trim().split("\n\n").map((event) => {
      const [kind, data] = event.split("\n")
      expect(kind).toBe("event: message")
      return JSON.parse(data!.replace(/^data: /, ""))
    })
    expect(events.length).toBe(2)
    expect(events[0]).toEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
    expect(events[1]).toMatchObject({ jsonrpc: "2.0", id: 7, result: { isError: false } })

    // A client that only takes JSON gets only the answer.
    const plain = await post("application/json", 8, "delete_custom_tool")
    expect(plain.headers.get("content-type")).toContain("application/json")
    expect(await plain.json()).toMatchObject({ id: 8, result: { isError: false } })

    // And a call that changes nothing is plain JSON whatever the client accepts.
    const list = await server.rpc(tokens.author!, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "list_custom_tools" } })
    expect(list.body.result.isError).toBe(false)
  })

  test("every authoring call is logged against the key, with the SQL it carried", async () => {
    const logs = (await server.api("GET", `/logs?key_id=${ids["author-only"]}`)).body.logs
    expect(logs.map((entry: any) => [entry.tool, entry.kind, entry.status])).toEqual([
      ["delete_custom_tool", "builtin", "ok"],
      ["for_others", "custom", "denied"],
      ["create_custom_tool", "builtin", "ok"]
    ])
    expect(logs[2]).toMatchObject({ source: "mcp", key_name: "author-only", sql: "SELECT 1 AS one" })
    const refused = (await server.api("GET", `/logs?key_id=${ids.author}&tool=create_custom_tool&status=error`)).body.logs
    expect(refused.some((entry: any) => entry.error.includes("holds execute_sql"))).toBe(true)
  })
})

describe("key lifecycle", () => {
  test("changing a key's grants takes effect on the next request", async () => {
    await createKey("shifting", { groups: ["schema"] })
    const client = await connect(tokens.shifting!)
    expect((await client.listTools()).tools.length).toBe(5)
    await expect(client.callTool({ name: "query", arguments: { sql: "SELECT 1" } })).rejects.toThrow()

    await server.api("PATCH", `/keys/${ids.shifting}`, { groups: ["schema", "read"] })
    expect((await client.listTools()).tools.length).toBe(7)
    expect((await client.callTool({ name: "query", arguments: { sql: "SELECT 1" } })).isError).toBe(false)

    await server.api("PATCH", `/keys/${ids.shifting}`, { groups: [] })
    expect((await client.listTools()).tools).toEqual([])
    await client.close()
  })

  test("a disabled key is refused, and works again when re-enabled", async () => {
    await createKey("toggle", { groups: ["read"] })
    const message = { jsonrpc: "2.0", id: 1, method: "tools/list" }
    expect((await server.rpc(tokens.toggle!, message)).status).toBe(200)

    await server.api("PATCH", `/keys/${ids.toggle}`, { enabled: false })
    const refused = await server.rpc(tokens.toggle!, message)
    expect(refused.status).toBe(403)
    expect(refused.body.error.message).toContain("disabled")
    await expect(connect(tokens.toggle!)).rejects.toThrow()

    await server.api("PATCH", `/keys/${ids.toggle}`, { enabled: true })
    expect((await server.rpc(tokens.toggle!, message)).status).toBe(200)
  })

  test("a revoked key stops working at once", async () => {
    await createKey("doomed", { groups: ["read"] })
    const client = await connect(tokens.doomed!)
    await server.api("DELETE", `/keys/${ids.doomed}`)
    await expect(client.listTools()).rejects.toThrow()
    expect((await server.rpc(tokens.doomed!, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401)
  })

  test("last_used_at is recorded", async () => {
    await createKey("fresh-key", { groups: ["read"] })
    const before = (await server.api("GET", "/keys")).body.find((key: any) => key.id === ids["fresh-key"])
    expect(before.last_used_at).toBeNull()
    await server.rpc(tokens["fresh-key"]!, { jsonrpc: "2.0", id: 1, method: "ping" })
    const after = (await server.api("GET", "/keys")).body.find((key: any) => key.id === ids["fresh-key"])
    expect(new Date(after.last_used_at).getTime()).toBeGreaterThan(Date.now() - 10_000)
  })
})

describe("transport", () => {
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list" }

  test("requires a key", async () => {
    const none = await server.rpc(null, list)
    expect(none.status).toBe(401)
    expect(none.body.error.message).toContain("Missing API key")
    const wrong = await server.rpc("p2m_not_a_real_key", list)
    expect(wrong.status).toBe(401)
    expect(wrong.body.error.message).toBe("Invalid API key")
  })

  test("an admin session is not an API key", async () => {
    expect((await server.rpc(server.session, list)).status).toBe(401)
  })

  test("accepts the key as x-api-key too", async () => {
    const response = await server.rpc(null, list, { "x-api-key": tokens.support! })
    expect(response.status).toBe(200)
    expect(response.body.result.tools.length).toBe(2)
  })

  test("notifications are acknowledged with 202 and no body", async () => {
    const response = await server.rpc(tokens.reader!, { jsonrpc: "2.0", method: "notifications/initialized" })
    expect(response).toEqual({ status: 202, body: null })
  })

  test("batches", async () => {
    const response = await server.rpc(tokens.reader!, [
      { jsonrpc: "2.0", id: "a", method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: "b", method: "nope" }
    ])
    expect(response.body).toEqual([
      { jsonrpc: "2.0", id: "a", result: {} },
      { jsonrpc: "2.0", id: "b", error: { code: -32601, message: "Method not found: nope" } }
    ])
    expect((await server.rpc(tokens.reader!, [])).body.error.code).toBe(-32600)
  })

  test("malformed requests get JSON-RPC errors", async () => {
    const notJson = await server.rpc(tokens.reader!, "{nope")
    expect(notJson.status).toBe(400)
    expect(notJson.body.error.code).toBe(-32700)
    expect((await server.rpc(tokens.reader!, { id: 1, method: "ping" })).body.error.code).toBe(-32600)
    expect((await server.rpc(tokens.reader!, { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })).body.error.code)
      .toBe(-32602)
  })

  test("optional lists some clients probe for are empty, not errors", async () => {
    const ask = async (method: string) => (await server.rpc(tokens.reader!, { jsonrpc: "2.0", id: 1, method })).body.result
    expect(await ask("resources/list")).toEqual({ resources: [] })
    expect(await ask("resources/templates/list")).toEqual({ resourceTemplates: [] })
    expect(await ask("prompts/list")).toEqual({ prompts: [] })
  })

  test("GET and DELETE are not offered; CORS preflight is", async () => {
    expect((await fetch(`${server.url}/mcp`)).status).toBe(405)
    expect((await fetch(`${server.url}/mcp`, { method: "DELETE" })).status).toBe(405)
    const preflight = await fetch(`${server.url}/mcp`, {
      method: "OPTIONS",
      headers: { origin: "https://inspector.example", "access-control-request-method": "POST" }
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*")
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization")
  })
})

describe("result formats", () => {
  const sql = "SELECT id, email FROM customers WHERE id <= 2 ORDER BY id"
  const run = async (key: string, name = "query", args: Record<string, unknown> = { sql }) => {
    const client = await connect(tokens[key]!)
    const result: any = await client.callTool({ name, arguments: args })
    await client.close()
    return result.content.map((block: any) => block.text)
  }
  const setDefault = (result_format: string) => server.api("PATCH", "/settings", { result_format })

  test("the server default applies to keys that do not choose", async () => {
    expect((await server.api("GET", "/settings")).body).toEqual({ result_format: "compact" })
    expect(await run("reader")).toEqual([
      "{\"columns\":[\"id\",\"email\"],\"rows\":[[1,\"user1@example.com\"],[2,\"user2@example.com\"]],\"row_count\":2}"
    ])

    expect((await setDefault("objects")).body).toEqual({ result_format: "objects" })
    expect(JSON.parse((await run("reader"))[0])).toEqual({
      rows: [{ id: 1, email: "user1@example.com" }, { id: 2, email: "user2@example.com" }],
      row_count: 2
    })

    await setDefault("markdown")
    expect(await run("reader")).toEqual([
      "| id | email |\n| --- | --- |\n| 1 | user1@example.com |\n| 2 | user2@example.com |\n\n2 rows"
    ])

    await setDefault("csv")
    expect(await run("reader")).toEqual(["id,email\n1,user1@example.com\n2,user2@example.com"])
  })

  test("applies to custom tools and to the built-in tools that return rows", async () => {
    // Still csv from the previous test.
    expect(await run("support", "orders_by_status", { status: "paid", limit: 1 })).toEqual(["id,total\n1,1.5"])
    const tables = (await run("reader", "list_tables", { schema: "billing" }))[0]
    expect(tables.split("\n")[0]).toBe("schema,name,type,estimated_rows,size,comment")
    expect(tables.split("\n")[1]).toStartWith("billing,invoices,table,")
    // Not rows: a document, a plan, an acknowledgement.
    expect(JSON.parse((await run("reader", "describe_table", { table: "orders" }))[0]).name).toBe("orders")
    expect(JSON.parse((await run("reader", "explain_query", { sql: "SELECT 1" }))[0]).plan).toContain("Result")
  })

  test("a key's own format wins over the default, and null hands it back", async () => {
    await createKey("md-client", { groups: ["read"] })
    await server.api("PATCH", `/keys/${ids["md-client"]}`, { result_format: "markdown" })
    expect((await run("md-client"))[0]).toStartWith("| id | email |")
    expect((await run("reader"))[0]).toStartWith("id,email")

    await server.api("PATCH", `/keys/${ids["md-client"]}`, { result_format: null })
    expect((await run("md-client"))[0]).toStartWith("id,email")
    // Leaving the field out of an update does not touch it.
    await server.api("PATCH", `/keys/${ids["md-client"]}`, { result_format: "objects" })
    await server.api("PATCH", `/keys/${ids["md-client"]}`, { name: "renamed" })
    expect((await server.api("GET", "/keys")).body.find((key: any) => key.id === ids["md-client"]).result_format).toBe("objects")
  })

  test("a key can be created with a format; unknown formats are refused", async () => {
    const created = await server.api("POST", "/keys", { name: "csv-key", groups: ["read"], result_format: "csv" })
    expect(created.body.key.result_format).toBe("csv")
    expect((await server.api("POST", "/keys", { name: "bad", result_format: "yaml" })).status).toBe(400)
    expect((await setDefault("yaml")).status).toBe(400)
  })

  test("truncation and statements without rows are reported in every format", async () => {
    const big = { sql: "SELECT generate_series(1, 5000) AS n" }
    await setDefault("csv")
    const csv = await run("reader", "query", big)
    expect(csv.length).toBe(2)
    expect(csv[0].split("\n").length).toBe(1001)
    expect(csv[1]).toContain("cut at the row/size limit")

    await setDefault("markdown")
    expect((await run("reader", "query", big))[0]).toEndWith("1000 rows shown. Result was cut at the row/size limit. Narrow the query or add LIMIT.")
    expect(await run("writer", "execute_sql", { sql: "UPDATE scratch SET note = note" })).toEqual(["UPDATE 3"])

    await setDefault("compact")
    expect(JSON.parse((await run("reader", "query", big))[0])).toMatchObject({ row_count: 1000, truncated: true })
  })

  test("errors are plain text whatever the format", async () => {
    await setDefault("csv")
    const client = await connect(tokens.reader!)
    const failed: any = await client.callTool({ name: "query", arguments: { sql: "SELECT * FROM nowhere" } })
    expect(failed.isError).toBe(true)
    expect(textOf(failed)).toContain("relation \"nowhere\" does not exist")
    await client.close()
    await setDefault("compact")
  })
})

describe("logging of MCP calls", () => {
  test("ok, error and denied calls are attributed to the key", async () => {
    await server.api("DELETE", "/logs")
    const client = await connect(tokens.support!)
    await client.callTool({ name: "orders_by_status", arguments: { status: "paid" } })
    await client.callTool({ name: "orders_by_status", arguments: { status: "bogus" } })
    await client.callTool({ name: "query", arguments: { sql: "SELECT 1" } }).catch(() => undefined)
    await client.listTools()
    await client.close()

    const logs = (await server.api("GET", "/logs?source=mcp")).body.logs
    // Listing tools and the handshake are not tool calls and are not logged.
    expect(logs.map((entry: any) => [entry.tool, entry.status])).toEqual([
      ["query", "denied"],
      ["orders_by_status", "error"],
      ["orders_by_status", "ok"]
    ])
    for (const entry of logs) {
      expect(entry).toMatchObject({ source: "mcp", key_id: ids.support, key_name: "support" })
      expect(entry.client).toBeTruthy()
    }
    expect(logs[0]).toMatchObject({ kind: "builtin", sql: null, error: "Not allowed for this API key" })
    expect(JSON.parse(logs[0].args)).toEqual({ sql: "SELECT 1" })
    expect(logs[1].error).toContain("order_status")
    expect(logs[2]).toMatchObject({ row_count: 2, kind: "custom" })

    expect((await server.api("GET", `/logs?key_id=${ids.support}`)).body.logs.length).toBe(3)
    expect((await server.api("GET", "/logs?status=denied")).body.logs.length).toBe(1)

    const stats = (await server.api("GET", "/stats?range=1h")).body
    expect(stats.totals).toMatchObject({ calls: 3, ok: 1, errors: 1, denied: 1 })
    expect(stats.by_key).toEqual([{ key_id: ids.support, key_name: "support", calls: 3, errors: 1 }])
  })
})
