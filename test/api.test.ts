// The admin API and the tool engine behind it, against a real database.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import pg from "pg"
import { DATABASE_URL, direct, seedDatabase, startServer, type TestServer } from "./harness.ts"

let server: TestServer

beforeAll(async () => {
  await seedDatabase()
  // Small limits so the caps are cheap to hit.
  server = await startServer({ P2M_MAX_ROWS: "50", P2M_QUERY_TIMEOUT_MS: "700" })
})

afterAll(async () => {
  await server.stop()
})

const call = (name: string, args: Record<string, unknown> = {}) =>
  server.api("POST", `/tools/${name}/call`, { arguments: args })

const sql = (statement: string, extra: Record<string, unknown> = {}) =>
  server.api("POST", "/sql", { sql: statement, ...extra })

describe("auth", () => {
  test("health and the setup state are public", async () => {
    const health = await server.api("GET", "/health", undefined, "")
    expect(health).toEqual({ status: 200, body: { ok: true, version: expect.any(String), database: true } })
    const state = await server.api("GET", "/auth/state", undefined, "")
    expect(state.body).toEqual({ setup_required: false, setup_code_required: false, version: expect.any(String) })
  })

  test("everything else needs a session", async () => {
    for (const path of ["/status", "/tools", "/keys", "/groups", "/custom-tools", "/logs", "/stats", "/settings", "/schema", "/auth/me"]) {
      expect((await server.api("GET", path, undefined, "")).status).toBe(401)
      expect((await server.api("GET", path, undefined, "wrong")).status).toBe(401)
    }
    expect((await server.api("POST", "/sql", { sql: "SELECT 1" }, "wrong")).status).toBe(401)
  })

  test("an API key is not a session", async () => {
    const created = await server.api("POST", "/keys", { name: "not-admin", groups: ["all"] })
    expect((await server.api("GET", "/status", undefined, created.body.token)).status).toBe(401)
    await server.api("DELETE", `/keys/${created.body.key.id}`)
  })

  test("unknown API routes answer JSON, not the dashboard", async () => {
    const response = await server.api("GET", "/nope")
    expect(response.status).toBe(404)
    expect(response.body._tag).toBe("NotFound")
  })

  test("status reports the database", async () => {
    const { body } = await server.api("GET", "/status")
    expect(body.database).toMatchObject({ connected: true, name: "postgres2mcp_test", error: null })
    // No public address was configured, so the dashboard uses the one it was opened at.
    expect(body.public_url).toBeNull()
    expect(body.limits).toEqual({ max_rows: 50, query_timeout_ms: 700, log_retention_days: 30 })
    expect(body.counts.tools).toBeGreaterThanOrEqual(16)
    expect(body.counts.custom_tools).toBe(0)
  })
})

describe("catalog", () => {
  test("lists built-in tools with object input schemas", async () => {
    const { body } = await server.api("GET", "/tools")
    const names = body.tools.map((tool: any) => tool.name)
    for (
      const expected of [
        "list_schemas",
        "list_tables",
        "describe_table",
        "list_relationships",
        "search_schema",
        "query",
        "explain_query",
        "execute_sql",
        "database_stats",
        "table_stats",
        "index_stats",
        "active_queries",
        "truncate_table",
        "drop_table",
        "vacuum_analyze",
        "cancel_query"
      ]
    ) expect(names).toContain(expected)
    for (const tool of body.tools) {
      expect(tool.input_schema.type).toBe("object")
      expect(tool.groups).toContain("all")
    }
    const describeTable = body.tools.find((tool: any) => tool.name === "describe_table")
    expect(describeTable.input_schema.required).toEqual(["table"])
    expect(describeTable.input_schema.properties.schema.type).toBe("string")
  })

  test("ships the default groups, admin tools kept apart", async () => {
    const { body } = await server.api("GET", "/groups")
    const byId = Object.fromEntries(body.map((group: any) => [group.id, group]))
    expect(Object.keys(byId)).toEqual(["schema", "read", "write", "monitoring", "admin", "authoring", "custom", "all"])
    expect(byId.authoring.tools).toEqual([
      "list_custom_tools",
      "test_custom_tool",
      "create_custom_tool",
      "update_custom_tool",
      "delete_custom_tool"
    ])
    expect(byId.admin.tools).toEqual(["truncate_table", "drop_table", "vacuum_analyze", "cancel_query"])
    expect(byId.read.tools).toEqual(["query", "explain_query"])
    expect(byId.write.tools).toEqual(["execute_sql"])
    expect(byId.admin.builtin).toBe(true)
  })
})

describe("schema tools", () => {
  test("list_schemas", async () => {
    const { body } = await call("list_schemas")
    const schemas = Object.fromEntries(body.data.schemas.map((row: any) => [row.schema, row]))
    expect(schemas.public).toMatchObject({ tables: 5, views: 1 })
    expect(schemas.billing).toMatchObject({ tables: 1 })
    expect(schemas.pg_catalog).toBeUndefined()
  })

  test("list_tables, all schemas and one", async () => {
    const all = (await call("list_tables")).body.data.tables
    expect(all.map((row: any) => `${row.schema}.${row.name}`)).toEqual([
      "billing.invoices",
      "public.Odd \"Name",
      "public.customers",
      "public.doomed",
      "public.orders",
      "public.paid_orders",
      "public.scratch"
    ])
    const customers = all.find((row: any) => row.name === "customers")
    expect(customers).toMatchObject({ type: "table", estimated_rows: 20, comment: "People who buy things" })
    expect(all.find((row: any) => row.name === "paid_orders")).toMatchObject({ type: "view", estimated_rows: null })

    const billing = (await call("list_tables", { schema: "billing" })).body.data.tables
    expect(billing.map((row: any) => row.name)).toEqual(["invoices"])
  })

  test("describe_table gives columns, keys, constraints and indexes", async () => {
    const { body } = await call("describe_table", { table: "orders" })
    const table = body.data
    expect(table).toMatchObject({ schema: "public", name: "orders", type: "table", primary_key: ["id"] })
    expect(table.columns.map((column: any) => column.name)).toEqual(["id", "customer_id", "status", "total", "placed_on"])
    expect(table.columns[2]).toMatchObject({
      type: "order_status",
      nullable: false,
      enum_values: ["pending", "paid", "shipped"]
    })
    expect(table.columns[3].type).toBe("numeric(12,2)")
    expect(table.foreign_keys).toEqual([{
      name: "orders_customer_id_fkey",
      references: "customers",
      definition: "FOREIGN KEY (customer_id) REFERENCES customers(id)"
    }])
    expect(table.referenced_by.map((ref: any) => ref.table)).toEqual(["billing.invoices"])
    expect(table.constraints).toEqual([{ name: "orders_total_check", type: "check", definition: expect.stringContaining("total >=") }])
    expect(table.indexes.map((index: any) => index.name)).toEqual(["orders_customer_idx", "orders_pkey"])
  })

  test("describe_table on a view, another schema, and an awkward name", async () => {
    const view = (await call("describe_table", { table: "paid_orders" })).body.data
    expect(view.type).toBe("view")
    expect(view.view_definition).toContain("FROM orders")

    const invoice = (await call("describe_table", { table: "invoices", schema: "billing" })).body.data
    expect(invoice.schema).toBe("billing")

    const odd = (await call("describe_table", { table: "Odd \"Name" })).body.data
    expect(odd.name).toBe("Odd \"Name")
    const comment = (await call("describe_table", { table: "customers" })).body.data
    expect(comment.columns.find((column: any) => column.name === "email").comment).toBe("Login address")
  })

  test("describe_table on a missing table is a clear 400", async () => {
    const response = await call("describe_table", { table: "nope" })
    expect(response.status).toBe(400)
    expect(response.body.message).toContain("\"public.nope\" not found")
  })

  test("list_relationships", async () => {
    const { body } = await call("list_relationships")
    expect(body.data.relationships).toEqual([
      {
        name: "invoices_order_id_fkey",
        from_table: "billing.invoices",
        from_columns: ["order_id"],
        to_table: "public.orders",
        to_columns: ["id"]
      },
      {
        name: "orders_customer_id_fkey",
        from_table: "public.orders",
        from_columns: ["customer_id"],
        to_table: "public.customers",
        to_columns: ["id"]
      }
    ])
  })

  test("search_schema finds tables and columns, treating wildcards literally", async () => {
    const matches = (await call("search_schema", { term: "CUSTOMER" })).body.data.matches
    expect(matches).toContainEqual({ schema: "public", table: "customers", column: null, type: "table" })
    expect(matches).toContainEqual({ schema: "public", table: "orders", column: "customer_id", type: "integer" })
    expect((await call("search_schema", { term: "%" })).body.data.matches).toEqual([])
  })
})

describe("arguments", () => {
  test("missing, mistyped and unexpected arguments are rejected", async () => {
    const missing = await call("describe_table", {})
    expect(missing.status).toBe(400)
    expect(missing.body.message).toContain("Invalid arguments")

    expect((await call("describe_table", { table: 5 })).status).toBe(400)
    expect((await call("describe_table", { table: "orders", bogus: true })).status).toBe(400)
    expect((await call("cancel_query", { pid: "1" })).status).toBe(400)
  })

  test("null means omitted", async () => {
    const response = await call("list_tables", { schema: null })
    expect(response.status).toBe(200)
    expect(response.body.data.tables.length).toBe(7)
  })

  test("unknown tool is a 404", async () => {
    expect((await call("nope")).status).toBe(404)
  })
})

describe("query (read-only SQL)", () => {
  test("returns columns and rows", async () => {
    const { body } = await call("query", { sql: "SELECT id, email FROM customers ORDER BY id LIMIT 2" })
    expect(body.data).toEqual({
      columns: ["id", "email"],
      rows: [[1, "user1@example.com"], [2, "user2@example.com"]],
      row_count: 2
    })
  })

  test("binds positional params", async () => {
    const { body } = await call("query", { sql: "SELECT $1::int + $2::int AS sum, $3::text AS t", params: [2, 40, "x"] })
    expect(body.data.rows).toEqual([[42, "x"]])
  })

  test("a hostile value stays a value", async () => {
    const { body } = await call("query", {
      sql: "SELECT count(*) FROM customers WHERE name = $1",
      params: ["x'; DROP TABLE customers; --"]
    })
    expect(body.data.rows).toEqual([[0]])
    expect((await direct("SELECT count(*)::int AS n FROM customers"))[0]!.n).toBe(20)
  })

  test("keeps duplicate column names apart", async () => {
    const { body } = await call("query", { sql: "SELECT 1 AS a, 2 AS a" })
    expect(body.data).toMatchObject({ columns: ["a", "a"], rows: [[1, 2]] })
  })

  test("renders Postgres types faithfully", async () => {
    const { body } = await call("query", {
      sql: `SELECT 9007199254740993::bigint AS big, 42::bigint AS small, 14.50::numeric AS money,
                   123456789012345678901234567890.5::numeric AS huge, 'NaN'::numeric AS nan,
                   '2026-01-02'::date AS d, '2026-01-02 03:04:05+00'::timestamptz AT TIME ZONE 'UTC' AS ts,
                   '1 day 2 hours'::interval AS i, '{"a": [1, null]}'::jsonb AS j, ARRAY[1, 2] AS arr,
                   ARRAY['a', NULL] AS texts, '\\xdeadbeef'::bytea AS bin, NULL AS nothing, true AS yes,
                   'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid AS id, 1.5::float8 AS f`
    })
    expect(body.data.columns).toEqual([
      "big", "small", "money", "huge", "nan", "d", "ts", "i", "j", "arr", "texts", "bin", "nothing", "yes", "id", "f"
    ])
    expect(body.data.rows[0]).toEqual([
      "9007199254740993", // beyond float64: kept as text rather than rounded
      42,
      14.5,
      "123456789012345678901234567890.5",
      "NaN",
      "2026-01-02",
      "2026-01-02 03:04:05",
      "1 day 02:00:00",
      { a: [1, null] },
      [1, 2],
      ["a", null],
      "\\xdeadbeef",
      null,
      true,
      "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      1.5
    ])
  })

  test("numeric arrays preserve precision, special values, NULLs and dimensions", async () => {
    const { status, body } = await call("query", {
      sql: `SELECT ARRAY[12345678901234567890.123::numeric, 14.50, NULL, 'NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric] AS nums,
                   ARRAY[[9007199254740993::numeric, NULL], [1.25, -12345678901234567890.123]] AS nested,
                   ARRAY[]::numeric[] AS empty, NULL::numeric[] AS absent,
                   '[0:1]={12345678901234567890.123,2.5}'::numeric[] AS shifted`
    })
    expect(status).toBe(200)
    expect(body.data.rows).toEqual([[
      ["12345678901234567890.123", 14.5, null, "NaN", "Infinity", "-Infinity"],
      [["9007199254740993", null], [1.25, "-12345678901234567890.123"]],
      [], null, ["12345678901234567890.123", 2.5]
    ]])
  })

  test("caps rows and says so", async () => {
    const { body } = await call("query", { sql: "SELECT generate_series(1, 500) AS n" })
    expect(body.data.row_count).toBe(50)
    expect(body.data.rows.length).toBe(50)
    expect(body.data.truncated).toBe(true)
    expect(body.data.note).toContain("LIMIT")

    const exact = (await call("query", { sql: "SELECT generate_series(1, 50) AS n" })).body.data
    expect(exact.row_count).toBe(50)
    expect(exact.truncated).toBeUndefined()
  })

  test("the size cap includes the first row and counts UTF-8 bytes", async () => {
    for (const statement of ["SELECT repeat('x', 3000000) AS big", "SELECT repeat('界', 700000) AS big"]) {
      const { status, body } = await sql(statement)
      expect(status).toBe(200)
      expect(body).toMatchObject({ columns: ["big"], rows: [], row_count: 0, truncated: true })
    }
    // Ordinary rows before the cap are retained; an exact fit is not truncated.
    const partial = await sql("SELECT repeat('x', 1100000) AS big FROM generate_series(1, 2)")
    expect(partial.body.rows).toHaveLength(1)
    expect(partial.body.truncated).toBe(true)
    const exact = await sql("SELECT repeat('x', 1999996) AS big")
    expect(exact.body.rows[0][0]).toHaveLength(1999996)
    expect(exact.body.truncated).toBe(false)
  })

  test("COPY is refused in console, built-in and custom-tool execution", async () => {
    const statement = "/* outer /* nested */ comment */\n-- comment\rCoPy (SELECT 1) TO STDOUT"
    const query = await call("query", { sql: statement })
    expect(query.status).toBe(422)
    expect(query.body).toMatchObject({ code: "0A000", message: expect.stringContaining("COPY is not supported") })
    expect((await sql(statement)).status).toBe(422)
    expect((await call("execute_sql", { sql: "COPY scratch FROM STDIN" })).status).toBe(422)
    const created = await server.api("POST", "/custom-tools", { name: "copy_check", sql: "COPY (SELECT :n::int) TO STDOUT", params: [{ name: "n", type: "int" }] })
    expect(created.status).toBe(200)
    try {
      const copied = await call("copy_check", { n: 1 })
      expect(copied.status).toBe(422)
      expect(copied.body.code).toBe("0A000")
    } finally {
      await server.api("DELETE", "/custom-tools/copy_check")
    }
    // COPY inside a literal or an identifier is ordinary SQL, and the server stays up.
    expect((await sql("SELECT 'COPY (SELECT 1) TO STDOUT' AS \"copy\"")).body.rows).toEqual([["COPY (SELECT 1) TO STDOUT"]])
    expect((await server.api("GET", "/health", undefined, "")).status).toBe(200)
  })

  test("times out long statements", async () => {
    const started = Date.now()
    const response = await call("query", { sql: "SELECT pg_sleep(5)" })
    expect(response.status).toBe(422)
    expect(response.body.message).toContain("statement timeout")
    expect(Date.now() - started).toBeLessThan(3000)
    // The connection is still usable afterwards.
    expect((await call("query", { sql: "SELECT 1" })).status).toBe(200)
  })

  test("reports SQL errors with Postgres' own words", async () => {
    const response = await call("query", { sql: "SELECT * FROM missing_table" })
    expect(response.status).toBe(422)
    expect(response.body).toMatchObject({ _tag: "QueryError", code: "42P01" })
    expect(response.body.message).toContain("missing_table")
    expect(response.body.position).toBe(15)
  })

  test("rejects empty SQL and batches", async () => {
    expect((await call("query", { sql: "  -- nothing" })).body.message).toBe("SQL is required")
    const batch = await call("query", { sql: "SELECT 1; SELECT 2" })
    expect(batch.status).toBe(400)
    expect(batch.body.message).toContain("single SQL statement")
  })
})

describe("read-only enforcement", () => {
  const blocked = async (statement: string) => {
    const response = await call("query", { sql: statement })
    expect(response.status).not.toBe(200)
    return response.body
  }

  test("writes are refused by Postgres, with a hint", async () => {
    for (
      const statement of [
        "INSERT INTO scratch (note) VALUES ('nope')",
        "UPDATE scratch SET note = 'nope'",
        "DELETE FROM scratch",
        "TRUNCATE scratch",
        "DROP TABLE scratch",
        "CREATE TABLE sneaky (id int)",
        "ALTER TABLE scratch ADD COLUMN x int",
        "WITH gone AS (DELETE FROM scratch RETURNING *) SELECT * FROM gone",
        "SELECT nextval('scratch_id_seq')",
        "COMMENT ON TABLE scratch IS 'x'"
      ]
    ) {
      const body = await blocked(statement)
      expect(body.code).toBe("25006")
      expect(body.hint).toContain("read-only")
    }
    expect(await direct("SELECT note FROM scratch ORDER BY id")).toEqual([{ note: "a" }, { note: "b" }, { note: "c" }])
    expect(await direct("SELECT to_regclass('public.sneaky') AS t")).toEqual([{ t: null }])
  })

  test("the transaction cannot be flipped to read-write", async () => {
    await blocked("SET TRANSACTION READ WRITE")
    await blocked("SELECT set_config('transaction_read_only', 'off', true)")
    await blocked("DO $$ BEGIN SET LOCAL transaction_read_only = off; DELETE FROM scratch; END $$")
    await blocked("DO $$ BEGIN DELETE FROM scratch; END $$")
    expect((await direct("SELECT count(*)::int AS n FROM scratch"))[0]!.n).toBe(3)
  })

  test("a batch cannot smuggle a write past the transaction", async () => {
    for (
      const statement of [
        "COMMIT; DELETE FROM scratch",
        "SELECT 1; DELETE FROM scratch",
        "ROLLBACK; BEGIN; DELETE FROM scratch; COMMIT",
        "SELECT 1 /* ; */; DELETE FROM scratch -- ;"
      ]
    ) await blocked(statement)
    // COMMIT alone ends the read-only transaction early but changes nothing.
    await call("query", { sql: "COMMIT" })
    expect((await direct("SELECT count(*)::int AS n FROM scratch"))[0]!.n).toBe(3)
    // And the pool is still healthy.
    expect((await call("query", { sql: "SELECT 1 AS ok" })).body.data.rows).toEqual([[1]])
  })

  test("session settings do not leak between calls", async () => {
    await call("query", { sql: "SET statement_timeout = 0" })
    await call("query", { sql: "SET default_transaction_read_only = off" })
    const response = await call("query", { sql: "DELETE FROM scratch" })
    expect(response.status).toBe(422)
    expect(response.body.code).toBe("25006")
  })

  test("session advisory locks are released after both read and write calls", async () => {
    for (const tool of ["query", "execute_sql"]) {
      const response = await call(tool, { sql: "SELECT pg_advisory_lock(918273645)" })
      expect(response.status).toBe(200)
      // An independent connection must be able to acquire the same lock as
      // soon as the request completes, without waiting for pool idle expiry.
      expect(await direct("SELECT pg_try_advisory_lock(918273645) AS obtained")).toEqual([{ obtained: true }])
    }
    const failed = await call("query", {
      sql: "DO $$ BEGIN PERFORM pg_advisory_lock(918273645); RAISE EXCEPTION 'test failure'; END $$"
    })
    expect(failed.status).toBe(422)
    expect(await direct("SELECT pg_try_advisory_lock(918273645) AS obtained")).toEqual([{ obtained: true }])
  })

  test("successful writes cannot leak session settings and clean connections are reused", async () => {
    const first = await call("execute_sql", {
      sql: "SELECT pg_backend_pid(), set_config('application_name', 'leaked-setting', false)"
    })
    expect(first.status).toBe(200)
    const next = await call("query", { sql: "SELECT pg_backend_pid(), current_setting('application_name')" })
    expect(next.status).toBe(200)
    expect(next.body.data.rows[0][0]).toBe(first.body.data.rows[0][0])
    expect(next.body.data.rows[0][1]).not.toBe("leaked-setting")
  })

  test("explain_query plans without running, and analyze stays read-only", async () => {
    const plan = (await call("explain_query", { sql: "SELECT * FROM orders WHERE customer_id = 3" })).body.data.plan
    expect(plan).toContain("orders")
    expect(plan).not.toContain("actual time")

    const analyzed = (await call("explain_query", { sql: "SELECT count(*) FROM orders", analyze: true })).body.data.plan
    expect(analyzed).toContain("actual time")

    const write = await call("explain_query", { sql: "DELETE FROM scratch", analyze: true })
    expect(write.status).toBe(422)
    expect((await direct("SELECT count(*)::int AS n FROM scratch"))[0]!.n).toBe(3)
  })
})

describe("execute_sql (read-write)", () => {
  test("commits writes and reports affected rows", async () => {
    const insert = (await call("execute_sql", { sql: "INSERT INTO scratch (note) VALUES ($1), ($2)", params: ["d", "e"] })).body.data
    expect(insert).toEqual({ columns: [], rows: [], row_count: 2, command: "INSERT" })
    expect((await direct("SELECT count(*)::int AS n FROM scratch"))[0]!.n).toBe(5)

    const returning = (await call("execute_sql", { sql: "DELETE FROM scratch WHERE note IN ('d', 'e') RETURNING note" })).body.data
    expect(returning.rows.flat().sort()).toEqual(["d", "e"])
    expect((await direct("SELECT count(*)::int AS n FROM scratch"))[0]!.n).toBe(3)
  })

  test("a failed write leaves nothing behind", async () => {
    const response = await call("execute_sql", { sql: "INSERT INTO orders (customer_id, total) VALUES (1, -5)" })
    expect(response.status).toBe(422)
    expect(response.body.code).toBe("23514")
    expect((await direct("SELECT count(*)::int AS n FROM orders"))[0]!.n).toBe(300)
  })

  test("runs DDL", async () => {
    expect((await call("execute_sql", { sql: "CREATE TABLE made_here (id int)" })).status).toBe(200)
    expect(await direct("SELECT to_regclass('public.made_here')::text AS t")).toEqual([{ t: "made_here" }])
    await call("execute_sql", { sql: "DROP TABLE made_here" })
  })

  test("still one statement per call", async () => {
    expect((await call("execute_sql", { sql: "DELETE FROM scratch; DELETE FROM orders" })).status).toBe(400)
    expect((await direct("SELECT count(*)::int AS n FROM scratch"))[0]!.n).toBe(3)
  })
})

describe("monitoring tools", () => {
  test("database_stats", async () => {
    const { body } = await call("database_stats")
    expect(body.data).toMatchObject({ database: "postgres2mcp_test", tables: 6 })
    expect(body.data.size_bytes).toBeGreaterThan(0)
    expect(body.data.max_connections).toBeGreaterThan(0)
  })

  test("table_stats and index_stats", async () => {
    const tables = (await call("table_stats")).body.data.tables
    expect(tables.map((row: any) => row.name)).toContain("orders")
    expect(tables.find((row: any) => row.name === "orders").live_rows).toBe(300)

    const indexes = (await call("index_stats", { schema: "public" })).body.data.indexes
    expect(indexes.find((row: any) => row.name === "orders_pkey")).toMatchObject({ table: "orders", is_primary: true })
  })

  test("active_queries sees a running statement, cancel_query stops it", async () => {
    // A marker unique to this run, so a backend left over from an aborted run is never mistaken for ours.
    const marker = `sleeper-${crypto.randomUUID()}`
    const sleeper = direct(`SELECT pg_sleep(20) /* ${marker} */`).catch((error: Error) => error.message)
    await Bun.sleep(300)
    const active = (await call("active_queries")).body.data.queries
    const target = active.find((row: any) => row.query.includes(marker))
    expect(target).toBeDefined()
    expect(target.state).toBe("active")

    const cancelled = (await call("cancel_query", { pid: target.pid })).body.data
    expect(cancelled).toEqual({ ok: true, pid: target.pid, action: "cancelled" })
    expect(await sleeper).toContain("canceling statement")
  })
})

describe("admin tools", () => {
  test("truncate_table", async () => {
    await direct("CREATE TABLE to_truncate (id serial PRIMARY KEY, v int); INSERT INTO to_truncate (v) VALUES (1), (2)")
    const { body } = await call("truncate_table", { table: "to_truncate", restart_identity: true })
    expect(body.data).toEqual({ ok: true, truncated: "public.to_truncate" })
    expect((await direct("SELECT count(*)::int AS n FROM to_truncate"))[0]!.n).toBe(0)
    await direct("INSERT INTO to_truncate (v) VALUES (9)")
    expect((await direct("SELECT id FROM to_truncate"))[0]!.id).toBe(1)
  })

  test("truncate_table refuses a referenced table without cascade", async () => {
    const response = await call("truncate_table", { table: "customers" })
    expect(response.status).toBe(422)
    expect((await direct("SELECT count(*)::int AS n FROM customers"))[0]!.n).toBe(20)
  })

  test("drop_table, and if_exists", async () => {
    expect((await call("drop_table", { table: "doomed" })).body.data).toEqual({ ok: true, dropped: "public.doomed" })
    expect(await direct("SELECT to_regclass('public.doomed') AS t")).toEqual([{ t: null }])
    expect((await call("drop_table", { table: "doomed" })).status).toBe(422)
    expect((await call("drop_table", { table: "doomed", if_exists: true })).status).toBe(200)
  })

  test("identifiers are quoted, never interpolated", async () => {
    await direct("CREATE TABLE keep_me (id int)")
    const response = await call("drop_table", { table: "nope\"; DROP TABLE keep_me; --", if_exists: true })
    expect(response.status).toBe(200)
    expect(await direct("SELECT to_regclass('public.keep_me')::text AS t")).toEqual([{ t: "keep_me" }])
    await direct("DROP TABLE keep_me")
  })

  test("vacuum_analyze runs outside a transaction", async () => {
    const { status, body } = await call("vacuum_analyze", { table: "scratch" })
    expect(status).toBe(200)
    expect(body.data).toEqual({ ok: true, vacuumed: "public.scratch" })
  })

  test("vacuum_analyze times out while waiting for a lock", async () => {
    const locker = new pg.Client({ connectionString: DATABASE_URL })
    await locker.connect()
    let pending: ReturnType<typeof call> | undefined
    try {
      await locker.query("BEGIN")
      await locker.query("LOCK TABLE scratch IN ACCESS EXCLUSIVE MODE")
      pending = call("vacuum_analyze", { table: "scratch" })
      let timeout: ReturnType<typeof setTimeout> | undefined
      const response = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("VACUUM ignored the statement timeout")), 3000)
        })
      ]).finally(() => clearTimeout(timeout))
      expect(response.status).toBe(422)
      expect(response.body.code).toBe("57014")
      expect(response.body.message).toContain("statement timeout")
    } finally {
      await locker.query("ROLLBACK")
      await locker.end()
      await pending
    }
    expect((await call("vacuum_analyze", { table: "scratch" })).status).toBe(200)
    expect((await sql("SELECT 1")).status).toBe(200)
  })
})

describe("sql console", () => {
  test("read-only unless writes are asked for", async () => {
    const denied = await sql("UPDATE scratch SET note = note")
    expect(denied.status).toBe(422)
    const allowed = await sql("UPDATE scratch SET note = note", { allow_writes: true })
    expect(allowed.body).toMatchObject({ columns: [], row_count: 3, command: "UPDATE", truncated: false })
    expect(allowed.body.duration_ms).toBeGreaterThan(0)
  })

  test("returns a full QueryResult with params bound", async () => {
    const { body } = await sql("SELECT $1::text AS a, generate_series(1, 2) AS n", { params: ["hi"] })
    expect(body).toMatchObject({ columns: ["a", "n"], rows: [["hi", 1], ["hi", 2]], row_count: 2, command: "SELECT" })
  })
})

describe("schema snapshot", () => {
  test("lists tables with their columns, and is not logged as a call", async () => {
    await server.api("DELETE", "/logs")
    const { status, body } = await server.api("GET", "/schema")
    expect(status).toBe(200)
    const orders = body.tables.find((table: any) => table.schema === "public" && table.name === "orders")
    expect(orders.type).toBe("table")
    expect(orders.columns.slice(0, 3)).toEqual([
      { name: "id", type: "bigint" },
      { name: "customer_id", type: "integer" },
      { name: "status", type: "order_status" }
    ])
    expect(body.tables.find((table: any) => table.name === "paid_orders").type).toBe("view")
    expect(body.tables.find((table: any) => table.schema === "billing").name).toBe("invoices")
    expect(body.tables.some((table: any) => table.schema === "pg_catalog")).toBe(false)
    expect((await server.api("GET", "/logs")).body.logs).toEqual([])
  })
})

describe("custom tools", () => {
  const template = "SELECT id, total FROM orders WHERE status = :status::order_status ORDER BY id LIMIT :limit"
  const params = [{ name: "status", type: "string" }, { name: "limit", type: "int", default: 2 }]

  test("create, read, list", async () => {
    const created = await server.api("POST", "/custom-tools", { name: "orders_by_status", sql: template, params, description: "By status" })
    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({ name: "orders_by_status", version: 1, allow_writes: false, params })
    expect((await server.api("GET", "/custom-tools/orders_by_status")).body.sql).toBe(template)
    expect((await server.api("GET", "/custom-tools")).body.map((query: any) => query.name)).toContain("orders_by_status")
    expect((await server.api("GET", "/custom-tools/nope")).status).toBe(404)
  })

  test("becomes a tool in the custom group", async () => {
    const { body } = await server.api("GET", "/tools")
    const tool = body.tools.find((candidate: any) => candidate.name === "orders_by_status")
    expect(tool).toMatchObject({
      kind: "custom",
      access: "read",
      description: "By status",
      groups: ["custom", "all"],
      input_schema: {
        type: "object",
        properties: { status: { type: "string" }, limit: { type: "integer", default: 2 } },
        required: ["status"],
        additionalProperties: false
      }
    })
  })

  test("runs with params, defaults and type checks", async () => {
    const run = (values: Record<string, unknown>) => server.api("POST", "/custom-tools/orders_by_status/run", { params: values })
    expect((await run({ status: "paid" })).body.rows).toEqual([[1, 1.5], [4, 6]])
    expect((await run({ status: "paid", limit: 1 })).body.rows).toEqual([[1, 1.5]])
    expect((await run({})).body.message).toBe("Missing param \"status\" (expected a string)")
    expect((await run({ status: "paid", limit: "1" })).body.message).toBe("Param \"limit\" must be an integer")
    expect((await run({ status: "paid", extra: 1 })).body.message).toBe("Unknown param \"extra\"")
    const bad = await run({ status: "bogus" })
    expect(bad.status).toBe(422)
    expect(bad.body.message).toContain("order_status")
  })

  test("is callable as a tool, with the same result shape as query", async () => {
    const { body } = await call("orders_by_status", { status: "shipped", limit: 1 })
    expect(body.data).toEqual({ columns: ["id", "total"], rows: [[2, 3]], row_count: 1 })
  })

  test("validation at save time", async () => {
    const create = (body: Record<string, unknown>) => server.api("POST", "/custom-tools", body)
    expect((await create({ name: "Bad-Name", sql: "SELECT 1" })).body.message).toContain("Tool name must")
    expect((await create({ name: "query", sql: "SELECT 1" })).body.message).toContain("built-in tool")
    expect((await create({ name: "sql", sql: "SELECT 1" })).body.message).toContain("built-in tool")
    expect((await create({ name: "orders_by_status", sql: "SELECT 1" })).body.message).toContain("already exists")
    expect((await create({ name: "q1", sql: "" })).body.message).toBe("SQL is required")
    expect((await create({ name: "q1", sql: "SELECT 1; SELECT 2" })).body.message).toContain("single SQL statement")
    expect((await create({ name: "q1", sql: "SELECT :a", params: [] })).body.message).toBe("Placeholder \":a\" is not a declared param")
    expect((await create({ name: "q1", sql: "SELECT 1", params: [{ name: "a", type: "int" }] })).body.message)
      .toBe("Declared param \"a\" does not appear in the SQL")
    expect((await create({ name: "q1", sql: "SELECT :a", params: [{ name: "a", type: "int", default: "x" }] })).body.message)
      .toContain("default must be an integer")
    expect((await create({ name: "q1", sql: "SELECT :a", params: [{ name: "a", type: "date" }] })).status).toBe(400)
    expect((await server.api("GET", "/custom-tools/q1")).status).toBe(404)
  })

  test("params are derived from the SQL when omitted", async () => {
    const created = await server.api("POST", "/custom-tools", { name: "derived", sql: "SELECT :a AS a, ':b' AS b, :c::int AS c" })
    expect(created.body.params).toEqual([{ name: "a", type: "string" }, { name: "c", type: "string" }])
    await server.api("DELETE", "/custom-tools/derived")
  })

  test("editing SQL or params bumps the version; description does not", async () => {
    const patch = (body: Record<string, unknown>) => server.api("PATCH", "/custom-tools/orders_by_status", body)
    expect((await patch({ description: "Orders in a status" })).body.version).toBe(1)
    expect((await patch({ sql: template })).body.version).toBe(1)
    const edited = await patch({ sql: `${template} OFFSET :skip`, params: [...params, { name: "skip", type: "int", default: 0 }] })
    expect(edited.body.version).toBe(2)
    // New SQL without params keeps the declarations that still apply.
    const narrowed = await patch({ sql: template })
    expect(narrowed.body).toMatchObject({ version: 3, params })
    expect((await patch({ sql: "SELECT :nope", params })).status).toBe(400)
    expect((await server.api("PATCH", "/custom-tools/nope", { description: "x" })).status).toBe(404)
  })

  test("read-only by default; allow_writes opts in", async () => {
    await server.api("POST", "/custom-tools", { name: "add_note", sql: "INSERT INTO scratch (note) VALUES (:note) RETURNING id" })
    const refused = await call("add_note", { note: "saved" })
    expect(refused.status).toBe(422)
    expect(refused.body.code).toBe("25006")

    const updated = await server.api("PATCH", "/custom-tools/add_note", { allow_writes: true })
    expect(updated.body).toMatchObject({ allow_writes: true, version: 2 })
    expect((await server.api("GET", "/tools")).body.tools.find((tool: any) => tool.name === "add_note").access).toBe("write")
    expect((await call("add_note", { note: "saved" })).status).toBe(200)
    expect((await direct("SELECT count(*)::int AS n FROM scratch WHERE note = 'saved'"))[0]!.n).toBe(1)
    await direct("DELETE FROM scratch WHERE note = 'saved'")
  })

  test("drafts run without being stored", async () => {
    const test = (body: Record<string, unknown>) => server.api("POST", "/custom-tool-drafts/test", body)
    const ok = await test({ sql: "SELECT :n::int * 2 AS doubled", params: [{ name: "n", type: "int" }], values: { n: 21 } })
    expect(ok.body).toMatchObject({ columns: ["doubled"], rows: [[42]] })
    expect((await test({ sql: "SELECT :n", params: [] })).body.message).toBe("Placeholder \":n\" is not a declared param")
    expect((await test({ sql: "DELETE FROM scratch" })).status).toBe(422)
    const write = await test({ sql: "UPDATE scratch SET note = note", allow_writes: true })
    expect(write.body).toMatchObject({ command: "UPDATE", row_count: 3 })
    expect((await server.api("GET", "/custom-tools")).body.map((query: any) => query.name)).not.toContain("draft")
  })
})

describe("groups", () => {
  test("create, update, list", async () => {
    const created = await server.api("POST", "/groups", {
      id: "support",
      name: "Support desk",
      description: "Lookups",
      tools: ["orders_by_status", "list_tables", "list_tables"]
    })
    expect(created.body).toEqual({
      id: "support",
      name: "Support desk",
      description: "Lookups",
      builtin: false,
      tools: ["orders_by_status", "list_tables"]
    })
    const updated = await server.api("PATCH", "/groups/support", { tools: ["orders_by_status"], name: "Support" })
    expect(updated.body).toMatchObject({ name: "Support", description: "Lookups", tools: ["orders_by_status"] })
    expect((await server.api("GET", "/tools")).body.tools.find((tool: any) => tool.name === "orders_by_status").groups)
      .toEqual(["custom", "all", "support"])
  })

  test("validation", async () => {
    const create = (body: Record<string, unknown>) => server.api("POST", "/groups", body)
    expect((await create({ id: "Bad Id", tools: [] })).body.message).toContain("Group id must")
    expect((await create({ id: "support", tools: [] })).body.message).toContain("already exists")
    expect((await create({ id: "admin", tools: [] })).body.message).toContain("already exists")
    expect((await create({ id: "g2", tools: ["nope"] })).body.message).toBe("Unknown tool \"nope\"")
    expect((await server.api("PATCH", "/groups/support", { tools: ["nope"] })).status).toBe(400)
    expect((await server.api("PATCH", "/groups/nope", { name: "x" })).status).toBe(404)
  })

  test("built-in groups cannot be changed or deleted", async () => {
    expect((await server.api("PATCH", "/groups/admin", { tools: [] })).body.message).toContain("built-in group")
    expect((await server.api("DELETE", "/groups/all")).body.message).toContain("built-in group")
  })
})

describe("api keys", () => {
  let keyId = ""

  test("create returns the token once and resolves its tools", async () => {
    const created = await server.api("POST", "/keys", { name: "  analyst ", groups: ["schema", "support"], tools: ["query"] })
    expect(created.status).toBe(200)
    expect(created.body.token).toMatch(/^p2m_[A-Za-z0-9_-]{32}$/)
    expect(created.body.key).toMatchObject({
      name: "analyst",
      groups: ["schema", "support"],
      tools: ["query"],
      enabled: true,
      last_used_at: null,
      token_prefix: created.body.token.slice(0, 10)
    })
    expect(created.body.key.effective_tools).toEqual([
      "list_schemas",
      "list_tables",
      "describe_table",
      "list_relationships",
      "search_schema",
      "query",
      "orders_by_status"
    ])
    keyId = created.body.key.id

    const listed = (await server.api("GET", "/keys")).body.find((key: any) => key.id === keyId)
    expect(listed.token).toBeUndefined()
    expect(JSON.stringify(listed)).not.toContain(created.body.token)
  })

  test("the token is stored hashed", async () => {
    const created = await server.api("POST", "/keys", { name: "hash-check", groups: [] })
    const file = Bun.file(`${server.dataDir}/postgres2mcp.db`)
    const bytes = Buffer.from(await file.arrayBuffer())
    expect(bytes.includes(Buffer.from(created.body.token))).toBe(false)
    await server.api("DELETE", `/keys/${created.body.key.id}`)
  })

  test("validation", async () => {
    expect((await server.api("POST", "/keys", { name: " " })).body.message).toBe("A key needs a name")
    expect((await server.api("POST", "/keys", { name: "x", groups: ["nope"] })).body.message).toBe("Unknown group \"nope\"")
    expect((await server.api("POST", "/keys", { name: "x", tools: ["nope"] })).body.message).toBe("Unknown tool \"nope\"")
    expect((await server.api("PATCH", "/keys/key_missing", { name: "x" })).status).toBe(404)
    expect((await server.api("DELETE", "/keys/key_missing")).status).toBe(404)
  })

  test("update grants and state", async () => {
    const updated = await server.api("PATCH", `/keys/${keyId}`, { groups: ["read"], tools: [], enabled: false, name: "reader" })
    expect(updated.body).toMatchObject({ name: "reader", groups: ["read"], tools: [], enabled: false })
    expect(updated.body.effective_tools).toEqual(["query", "explain_query"])
  })

  test("the `all` and `custom` groups follow the catalog", async () => {
    const everything = (await server.api("POST", "/keys", { name: "everything", groups: ["all"] })).body.key
    const saved = (await server.api("POST", "/keys", { name: "saved", groups: ["custom"] })).body.key
    expect(saved.effective_tools.sort()).toEqual(["add_note", "orders_by_status"])

    await server.api("POST", "/custom-tools", { name: "later", sql: "SELECT 1" })
    const keys = (await server.api("GET", "/keys")).body
    expect(keys.find((key: any) => key.id === everything.id).effective_tools).toContain("later")
    expect(keys.find((key: any) => key.id === saved.id).effective_tools).toContain("later")
  })

  test("deleting a query or group strips the grants that named it", async () => {
    await server.api("POST", "/groups", { id: "temp", tools: ["later", "list_tables"] })
    const key = (await server.api("POST", "/keys", { name: "named", groups: ["temp"], tools: ["later"] })).body.key

    expect((await server.api("DELETE", "/custom-tools/later")).status).toBe(204)
    const afterQuery = (await server.api("GET", "/keys")).body.find((candidate: any) => candidate.id === key.id)
    expect(afterQuery.tools).toEqual([])
    expect((await server.api("GET", "/groups")).body.find((group: any) => group.id === "temp").tools).toEqual(["list_tables"])

    // Recreating the name must not hand the old grant back.
    await server.api("POST", "/custom-tools", { name: "later", sql: "SELECT 2" })
    const recreated = (await server.api("GET", "/keys")).body.find((candidate: any) => candidate.id === key.id)
    expect(recreated.effective_tools).toEqual(["list_tables"])

    expect((await server.api("DELETE", "/groups/temp")).status).toBe(204)
    const afterGroup = (await server.api("GET", "/keys")).body.find((candidate: any) => candidate.id === key.id)
    expect(afterGroup.groups).toEqual([])
    expect(afterGroup.effective_tools).toEqual([])
    expect((await server.api("DELETE", "/groups/temp")).status).toBe(404)
  })
})

describe("logs and stats", () => {
  test("every call is logged with what ran", async () => {
    await server.api("DELETE", "/logs")
    await call("query", { sql: "SELECT 'needle-ok' AS v" })
    await call("query", { sql: "SELECT * FROM needle_missing" })
    await call("orders_by_status", { status: "paid" })
    const tableCount = (await call("list_tables")).body.data.tables.length
    await sql("SELECT 'console'")
    await call("nope_tool")

    const { body } = await server.api("GET", "/logs")
    expect(body.logs.length).toBe(6)
    expect(body.next_before).toBeNull()
    const [unknown, console_, listTables, saved, failed, ok] = body.logs

    expect(ok).toMatchObject({
      source: "admin",
      key_id: null,
      tool: "query",
      kind: "builtin",
      status: "ok",
      row_count: 1,
      error: null,
      sql: "SELECT 'needle-ok' AS v"
    })
    expect(JSON.parse(ok.args)).toEqual({ sql: "SELECT 'needle-ok' AS v" })
    expect(ok.duration_ms).toBeGreaterThan(0)
    expect(new Date(ok.ts).getTime()).toBeGreaterThan(Date.now() - 60_000)

    expect(failed).toMatchObject({ tool: "query", status: "error", row_count: null, sql: "SELECT * FROM needle_missing" })
    expect(failed.error).toContain("needle_missing")
    expect(saved).toMatchObject({ tool: "orders_by_status", kind: "custom", status: "ok", row_count: 2 })
    expect(saved.sql).toStartWith("/* custom_tool:orders_by_status v3 */\nSELECT id, total FROM orders WHERE status = $1")
    expect(listTables).toMatchObject({ tool: "list_tables", kind: "builtin", row_count: tableCount })
    expect(listTables.sql).toContain("pg_class")
    expect(console_).toMatchObject({ tool: "sql", kind: "sql", sql: "SELECT 'console'" })
    expect(unknown).toMatchObject({ tool: "nope_tool", kind: "unknown", status: "error", error: "Unknown tool" })
  })

  test("filters and search", async () => {
    const list = async (query: string) => (await server.api("GET", `/logs?${query}`)).body.logs
    expect((await list("status=error")).map((entry: any) => entry.tool).sort()).toEqual(["nope_tool", "query"])
    expect((await list("tool=query")).length).toBe(2)
    expect((await list("q=needle-ok")).length).toBe(1)
    expect((await list("q=NEEDLE")).length).toBe(2)
    expect((await list("q=100%25")).length).toBe(0)
    expect((await list("source=mcp")).length).toBe(0)
    expect((await list("source=admin&status=ok&tool=sql")).length).toBe(1)
    expect((await server.api("GET", "/logs?status=bogus")).status).toBe(400)
  })

  test("pagination walks newest to oldest", async () => {
    const first = (await server.api("GET", "/logs?limit=4")).body
    expect(first.logs.length).toBe(4)
    expect(first.next_before).toBe(first.logs[3].id)
    const second = (await server.api("GET", `/logs?limit=4&before=${first.next_before}`)).body
    expect(second.logs.length).toBe(2)
    expect(second.next_before).toBeNull()
    const ids = [...first.logs, ...second.logs].map((entry: any) => entry.id)
    expect(ids).toEqual([...ids].sort((a, b) => b - a))
    expect(new Set(ids).size).toBe(6)
  })

  test("one entry by id", async () => {
    const id = (await server.api("GET", "/logs?limit=1")).body.logs[0].id
    expect((await server.api("GET", `/logs/${id}`)).body.id).toBe(id)
    expect((await server.api("GET", "/logs/999999")).status).toBe(404)
  })

  test("stats summarise the log", async () => {
    const { body } = await server.api("GET", "/stats?range=1h")
    expect(body.range).toBe("1h")
    expect(body.bucket_seconds).toBe(60)
    expect(body.series.length).toBe(60)
    expect(body.totals).toMatchObject({ calls: 6, ok: 4, errors: 2, denied: 0 })
    const logged = (await server.api("GET", "/logs")).body.logs
    expect(body.totals.rows).toBe(logged.reduce((sum: number, entry: any) => sum + (entry.row_count ?? 0), 0))
    expect(body.totals.rows).toBeGreaterThanOrEqual(1 + 2 + 6 + 1)
    expect(body.totals.p95_ms).toBeGreaterThanOrEqual(body.totals.avg_ms / 10)
    const plotted = body.series.reduce((sum: number, point: any) => sum + point.ok + point.errors + point.denied, 0)
    expect(plotted).toBe(6)
    expect(body.by_tool[0]).toMatchObject({ tool: "query", calls: 2, errors: 1 })
    expect(body.by_key).toEqual([{ key_id: null, key_name: "admin", calls: 6, errors: 2 }])

    for (const [range, buckets] of [["24h", 24], ["7d", 28], ["30d", 30]] as const) {
      const other = (await server.api("GET", `/stats?range=${range}`)).body
      expect(other.series.length).toBe(buckets)
      expect(other.totals.calls).toBe(6)
    }
    expect((await server.api("GET", "/stats")).body.range).toBe("24h")
    expect((await server.api("GET", "/stats?range=1y")).status).toBe(400)
  })

  test("clear", async () => {
    expect((await server.api("DELETE", "/logs")).body.deleted).toBe(6)
    expect((await server.api("GET", "/logs")).body.logs).toEqual([])
    expect((await server.api("GET", "/stats")).body.totals.calls).toBe(0)
  })
})
