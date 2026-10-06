// The SQLite store on its own, in memory, with the clock under test control —
// the parts of the log (retention, time buckets) that depend on when "now" is.
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { AppConfig, DEFAULTS } from "../src/services/AppConfig.ts"
import { hashToken, type NewLog, Store } from "../src/services/Store.ts"

const DAY = 86_400_000
const START = Date.parse("2026-03-10T12:30:00Z")

const config = (logRetentionDays: number) =>
  Layer.succeed(AppConfig, {
    databaseUrl: "postgres://unused",
    host: "127.0.0.1",
    port: 0,
    dataDir: ":memory:",
    bootstrapAdmin: null,
    setupToken: null,
    publicUrl: null,
    maxRows: DEFAULTS.maxRows,
    maxBytes: DEFAULTS.maxBytes,
    queryTimeoutMs: DEFAULTS.queryTimeoutMs,
    logRetentionDays,
    poolSize: 1,
    webDir: null
  })

const run = <A>(effect: Effect.Effect<A, never, Store>, retentionDays = 7): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function*() {
      yield* TestClock.setTime(START)
      return yield* effect
    }).pipe(
      Effect.provide(Store.layer.pipe(Layer.provide(config(retentionDays)))),
      Effect.provide(TestClock.layer())
    )
  )

const entry = (overrides: Partial<NewLog> = {}): NewLog => ({
  source: "mcp",
  key_id: "key_1",
  key_name: "tester",
  tool: "query",
  kind: "builtin",
  status: "ok",
  duration_ms: 10,
  row_count: 1,
  error: null,
  args: "{}",
  sql: "SELECT 1",
  client: null,
  ...overrides
})

describe("log retention", () => {
  test("prunes entries older than the window, keeps the rest", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* Store
      yield* store.insertLog(entry({ tool: "old" }))
      yield* TestClock.adjust(5 * DAY)
      yield* store.insertLog(entry({ tool: "recent" }))
      yield* TestClock.adjust(3 * DAY) // "old" is now 8 days old, "recent" 3
      const deleted = yield* store.pruneLogs
      return { deleted, left: (yield* store.listLogs({})).map((log) => log.tool) }
    }))
    expect(result).toEqual({ deleted: 1, left: ["recent"] })
  })

  test("a retention of 0 keeps everything", async () => {
    const result = await run(
      Effect.gen(function*() {
        const store = yield* Store
        yield* store.insertLog(entry())
        yield* TestClock.adjust(400 * DAY)
        return { deleted: yield* store.pruneLogs, left: (yield* store.listLogs({})).length }
      }),
      0
    )
    expect(result).toEqual({ deleted: 0, left: 1 })
  })
})

describe("stats", () => {
  test("buckets align to the clock and cover exactly the window", async () => {
    const stats = await run(Effect.gen(function*() {
      const store = yield* Store
      yield* store.insertLog(entry({ duration_ms: 10 })) // 12:30
      yield* store.insertLog(entry({ status: "error", duration_ms: 30, row_count: null }))
      yield* TestClock.adjust(2 * 3_600_000) // 14:30
      yield* store.insertLog(entry({ status: "denied", duration_ms: 0.1, row_count: null }))
      yield* TestClock.adjust(15 * 60_000) // 14:45
      return yield* store.stats("24h")
    }))

    expect(stats.series.length).toBe(24)
    expect(stats.series.at(-1)!.t).toBe("2026-03-10T14:00:00.000Z")
    expect(stats.series[0]!.t).toBe("2026-03-09T15:00:00.000Z")
    const noon = stats.series.find((point) => point.t === "2026-03-10T12:00:00.000Z")!
    expect(noon).toEqual({ t: "2026-03-10T12:00:00.000Z", ok: 1, errors: 1, denied: 0, avg_ms: 20 })
    // A denied call never ran, so it does not count towards latency.
    expect(stats.series.at(-1)).toEqual({ t: "2026-03-10T14:00:00.000Z", ok: 0, errors: 0, denied: 1, avg_ms: 0 })
    expect(stats.totals).toEqual({ calls: 3, ok: 1, errors: 1, denied: 1, rows: 1, avg_ms: 20, p95_ms: 30 })
  })

  test("calls older than the window fall out of it", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* Store
      yield* store.insertLog(entry())
      yield* TestClock.adjust(2 * 3_600_000)
      const store1h = yield* store.stats("1h")
      const store24h = yield* store.stats("24h")
      yield* TestClock.adjust(29 * DAY)
      const store7d = yield* store.stats("7d")
      const store30d = yield* store.stats("30d")
      return [store1h, store24h, store7d, store30d].map((stats) => [stats.series.length, stats.totals.calls])
    }))
    expect(result).toEqual([[60, 0], [24, 1], [28, 0], [30, 1]])
  })

  test("p95 is the slow tail, not the average", async () => {
    const stats = await run(Effect.gen(function*() {
      const store = yield* Store
      for (let i = 1; i <= 100; i++) yield* store.insertLog(entry({ duration_ms: i }))
      return yield* store.stats("1h")
    }))
    expect(stats.totals.avg_ms).toBe(50.5)
    expect(stats.totals.p95_ms).toBe(96)
  })

  test("callers without a key are grouped by where they came from", async () => {
    const stats = await run(Effect.gen(function*() {
      const store = yield* Store
      yield* store.insertLog(entry())
      yield* store.insertLog(entry({ source: "admin", key_id: null, key_name: null }))
      yield* store.insertLog(entry({ source: "admin", key_id: null, key_name: null, status: "error" }))
      yield* store.insertLog(entry({ source: "stdio", key_id: null, key_name: null }))
      return yield* store.stats("1h")
    }))
    expect(stats.by_key).toEqual([
      { key_id: null, key_name: "admin", calls: 2, errors: 1 },
      { key_id: null, key_name: "stdio", calls: 1, errors: 0 },
      { key_id: "key_1", key_name: "tester", calls: 1, errors: 0 }
    ])
  })
})

describe("log storage", () => {
  test("oversized payloads are clipped, not rejected", async () => {
    const [log] = await run(Effect.gen(function*() {
      const store = yield* Store
      yield* store.insertLog(entry({ sql: "x".repeat(50_000), args: "y".repeat(50_000), error: "z".repeat(50_000) }))
      return yield* store.listLogs({})
    }))
    expect(log!.sql!.length).toBeLessThan(20_100)
    expect(log!.sql).toEndWith("… [truncated]")
    expect(log!.args!.length).toBeLessThan(8_100)
    expect(log!.error!.length).toBeLessThan(4_100)
  })

  test("the limit is clamped", async () => {
    const counts = await run(Effect.gen(function*() {
      const store = yield* Store
      for (let i = 0; i < 5; i++) yield* store.insertLog(entry())
      return [
        (yield* store.listLogs({ limit: 0 })).length,
        (yield* store.listLogs({ limit: 3 })).length,
        (yield* store.listLogs({ limit: 10_000 })).length
      ]
    }))
    expect(counts).toEqual([1, 3, 5])
  })
})

describe("keys", () => {
  test("tokens are looked up by hash and never stored in the clear", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* Store
      const { key, token } = yield* store.createKey({ name: "k", groups: ["read"], tools: [], result_format: null })
      const found = yield* store.findKeyByToken(token)
      const missing = yield* store.findKeyByToken(`${token}x`)
      const byHash = yield* store.findKeyByToken(hashToken(token))
      return { key, token, found, missing, byHash }
    }))
    expect(result.token).toStartWith("p2m_")
    expect(result.found).toEqual(result.key)
    expect(result.missing).toBeNull()
    // Knowing the stored hash is not enough to authenticate.
    expect(result.byHash).toBeNull()
    expect(result.key.token_prefix).toBe(result.token.slice(0, 10))
  })
})

describe("upgrading a state file", () => {
  // The schema exactly as 0.1.0 created it, with some data in it.
  const V1 = `
    CREATE TABLE "effect_sql_migrations" (
      migration_id integer PRIMARY KEY NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    );
    INSERT INTO effect_sql_migrations (migration_id, name) VALUES (1, 'initial');
    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, token_prefix TEXT NOT NULL,
      groups TEXT NOT NULL DEFAULT '[]', tools TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, last_used_at TEXT
    );
    CREATE TABLE tool_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      tools TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
    );
    CREATE TABLE saved_queries (
      name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', sql TEXT NOT NULL, params TEXT NOT NULL DEFAULT '[]',
      allow_writes INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, key_id TEXT, key_name TEXT,
      tool TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, duration_ms REAL NOT NULL, row_count INTEGER,
      error TEXT, args TEXT, sql TEXT, client TEXT
    );
    CREATE INDEX logs_ts ON logs (ts);
    CREATE INDEX logs_tool ON logs (tool, ts);
    CREATE INDEX logs_key ON logs (key_id, ts);
    INSERT INTO api_keys (id, name, token_hash, token_prefix, groups, tools, created_at)
      VALUES ('key_old', 'legacy', '${hashToken("p2m_legacy_token")}', 'p2m_legacy', '["schema","queries"]', '["orders_by_status"]', '2026-01-01T00:00:00.000Z');
    INSERT INTO tool_groups (id, name, description, tools, created_at)
      VALUES ('support', 'Support', '', '["orders_by_status","list_tables"]', '2026-01-01T00:00:00.000Z');
    INSERT INTO saved_queries (name, description, sql, params, allow_writes, version, created_at, updated_at)
      VALUES ('orders_by_status', 'By status', 'SELECT * FROM orders WHERE status = :status',
              '[{"name":"status","type":"string"}]', 0, 4, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
    INSERT INTO logs (ts, source, key_id, key_name, tool, kind, status, duration_ms, row_count)
      VALUES (${START}, 'mcp', 'key_old', 'legacy', 'orders_by_status', 'query', 'ok', 3, 2),
             (${START}, 'mcp', 'key_old', 'legacy', 'list_tables', 'builtin', 'ok', 5, 6);
  `

  test("0.1.0 state carries over: saved queries become custom tools, keys and logs keep working", async () => {
    const { Database } = await import("bun:sqlite")
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "p2m-upgrade-"))
    const seed = new Database(join(dir, "postgres2mcp.db"))
    seed.exec(V1)
    seed.close()

    try {
      const state = await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* Store
          return {
            tools: yield* store.listCustomTools,
            key: yield* store.findKeyByToken("p2m_legacy_token"),
            groups: yield* store.listGroups,
            logs: yield* store.listLogs({}),
            settings: yield* store.getSettings,
            users: yield* store.countUsers
          }
        }).pipe(Effect.provide(Store.layer.pipe(Layer.provide(Layer.succeed(AppConfig, {
          databaseUrl: "postgres://unused",
          host: "127.0.0.1",
          port: 0,
          dataDir: dir,
          bootstrapAdmin: null,
          setupToken: null,
          publicUrl: null,
          maxRows: DEFAULTS.maxRows,
          maxBytes: DEFAULTS.maxBytes,
          queryTimeoutMs: DEFAULTS.queryTimeoutMs,
          logRetentionDays: 0,
          poolSize: 1,
          webDir: null
        })))))
      )

      expect(state.tools).toEqual([{
        name: "orders_by_status",
        description: "By status",
        sql: "SELECT * FROM orders WHERE status = :status",
        params: [{ name: "status", type: "string" }],
        allow_writes: false,
        version: 4,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z"
      }])
      // The built-in group was renamed; the key follows it and keeps its token.
      expect(state.key).toMatchObject({
        id: "key_old",
        groups: ["schema", "custom"],
        tools: ["orders_by_status"],
        enabled: true,
        result_format: null
      })
      expect(state.groups).toEqual([{ id: "support", name: "Support", description: "", tools: ["orders_by_status", "list_tables"] }])
      expect(state.logs.map((log) => [log.tool, log.kind])).toEqual([["list_tables", "builtin"], ["orders_by_status", "custom"]])
      expect(state.settings).toEqual({ result_format: "compact" })
      // No account yet: the upgraded server asks for first-run setup.
      expect(state.users).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
