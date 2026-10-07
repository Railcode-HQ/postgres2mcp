import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import pg from "pg"
import { DATABASE_URL, direct, seedDatabase, startServer, type TestServer } from "./harness.ts"

const role = `p2m_reader_${crypto.randomUUID().replaceAll("-", "")}`
const password = crypto.randomUUID()
const readerUrl = new URL(DATABASE_URL)
readerUrl.username = role
readerUrl.password = password

beforeAll(async () => {
  await seedDatabase()
  await direct(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`)
  await direct(`GRANT USAGE ON SCHEMA public TO ${role}`)
  await direct(`GRANT SELECT ON scratch TO ${role}`)
})

afterAll(async () => {
  await direct(`DROP OWNED BY ${role}`)
  await direct(`DROP ROLE ${role}`)
})

const call = (server: TestServer, name: string, sql: string) =>
  server.api("POST", `/tools/${name}/call`, { arguments: { sql } })

test("read-only grants still refuse writes after overriding the role default", async () => {
  await direct(`ALTER ROLE ${role} SET default_transaction_read_only = on`)
  const client = new pg.Client({ connectionString: readerUrl.toString() })
  await client.connect()
  try {
    expect((await client.query("SHOW default_transaction_read_only")).rows[0].default_transaction_read_only).toBe("on")
    await client.query("SET default_transaction_read_only = off")
    expect((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("off")
    await expect(client.query("DELETE FROM scratch")).rejects.toMatchObject({ code: "42501" })
  } finally {
    await client.end()
  }

  // Override the role default at connection startup, so even pool resets keep
  // execute_sql in read-write mode. Only the database grants prevent writes.
  const url = new URL(readerUrl)
  url.searchParams.set("options", "-c default_transaction_read_only=off")
  const server = await startServer({ DATABASE_URL: url.toString() })
  try {
    const mode = await call(server, "execute_sql", "SHOW transaction_read_only")
    expect(mode.status).toBe(200)
    expect(mode.body.data.rows).toEqual([["off"]])
    expect((await call(server, "execute_sql", "SET default_transaction_read_only = off")).status).toBe(200)
    const read = await call(server, "query", "SELECT note FROM scratch ORDER BY id")
    expect(read.status).toBe(200)
    expect(read.body.data.rows).toEqual([["a"], ["b"], ["c"]])
    for (const sql of [
      "INSERT INTO scratch (id, note) VALUES (99, 'nope')",
      "UPDATE scratch SET note = 'nope'",
      "DELETE FROM scratch"
    ]) {
      const response = await call(server, "execute_sql", sql)
      expect(response.status).toBe(422)
      expect(response.body.code).toBe("42501")
    }
    expect(await direct("SELECT note FROM scratch ORDER BY id")).toEqual([{ note: "a" }, { note: "b" }, { note: "c" }])
  } finally {
    await server.stop()
  }
})

describe("statement timeout precedence", () => {
  for (const [database, app, expected] of [
    ["250ms", 2000, "250ms"],
    ["2s", 500, "500ms"],
    ["0", 500, "500ms"],
    ["250ms", 0, "250ms"],
    ["0", 0, "0"]
  ] as const) {
    test(`role ${database}, app ${app}ms uses ${expected}`, async () => {
      await direct(`ALTER ROLE ${role} SET default_transaction_read_only = off`)
      await direct(`ALTER ROLE ${role} SET statement_timeout = '${database}'`)
      const server = await startServer({ DATABASE_URL: readerUrl.toString(), P2M_QUERY_TIMEOUT_MS: String(app) })
      try {
        for (const tool of ["query", "execute_sql", "query"]) {
          const response = await call(server, tool, "SHOW statement_timeout")
          expect(response.status).toBe(200)
          expect(response.body.data.rows).toEqual([[expected]])
        }
        if (database === "250ms" && app === 2000) {
          const response = await call(server, "query", "SELECT pg_sleep(1)")
          expect(response.status).toBe(422)
          expect(response.body.code).toBe("57014")
          expect((await call(server, "query", "SELECT 1")).status).toBe(200)
        }
      } finally {
        await server.stop()
      }
    })
  }

  test("VACUUM respects a shorter connection timeout outside a transaction", async () => {
    const url = new URL(DATABASE_URL)
    url.searchParams.set("options", "-c statement_timeout=250ms")
    const server = await startServer({ DATABASE_URL: url.toString(), P2M_QUERY_TIMEOUT_MS: "5000" })
    const locker = new pg.Client({ connectionString: DATABASE_URL })
    let pending: ReturnType<TestServer["api"]> | undefined
    try {
      await locker.connect()
      await locker.query("BEGIN")
      await locker.query("LOCK TABLE scratch IN ACCESS EXCLUSIVE MODE")
      pending = server.api("POST", "/tools/vacuum_analyze/call", { arguments: { table: "scratch" } })
      let timeout: ReturnType<typeof setTimeout> | undefined
      const response = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("VACUUM ignored the connection timeout")), 2000)
        })
      ]).finally(() => clearTimeout(timeout))
      expect(response.status).toBe(422)
      expect(response.body.code).toBe("57014")
    } finally {
      await locker.query("ROLLBACK")
      await locker.end()
      await pending
      await server.stop()
    }
  })
})
