// postgres2mcp's own state — accounts, API keys, tool groups, custom tools,
// settings and the call log — in one SQLite file under the data directory. The target
// database is never written to for bookkeeping.
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { Clock, Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { createHash, randomBytes } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type {
  CustomTool,
  LogEntry,
  LogSource,
  LogStatus,
  ResultFormat,
  Settings,
  Stats,
  StatsRange,
  ToolParam,
  User
} from "../domain.ts"
import { AppConfig } from "./AppConfig.ts"

export interface KeyRow {
  readonly id: string
  readonly name: string
  readonly token_prefix: string
  readonly groups: ReadonlyArray<string>
  readonly tools: ReadonlyArray<string>
  readonly enabled: boolean
  readonly created_at: string
  readonly last_used_at: string | null
  readonly result_format: ResultFormat | null
}

/** A custom tool as stored; which groups it belongs to is the groups' business. */
export type CustomToolRow = Omit<CustomTool, "groups">

export interface UserRow extends User {
  readonly password_hash: string
}

export interface SessionRow {
  readonly user_id: string
  readonly username: string
  readonly expires_at: number
}

export interface GroupRow {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly tools: ReadonlyArray<string>
}

export interface NewLog {
  readonly source: LogSource
  readonly key_id: string | null
  readonly key_name: string | null
  readonly tool: string
  readonly kind: LogEntry["kind"]
  readonly status: LogStatus
  readonly duration_ms: number
  readonly row_count: number | null
  readonly error: string | null
  readonly args: string | null
  readonly sql: string | null
  readonly client: string | null
}

export interface LogFilter {
  readonly limit?: number | undefined
  /** Return entries with an id below this one (keyset pagination, newest first). */
  readonly before?: number | undefined
  readonly tool?: string | undefined
  readonly key_id?: string | undefined
  readonly status?: LogStatus | undefined
  readonly source?: LogSource | undefined
  /** Substring match over tool, SQL, arguments and error. */
  readonly q?: string | undefined
}

export class Store extends Context.Service<Store, {
  readonly listKeys: Effect.Effect<Array<KeyRow>>
  getKey(id: string): Effect.Effect<KeyRow | null>
  findKeyByToken(token: string): Effect.Effect<KeyRow | null>
  createKey(input: {
    readonly name: string
    readonly groups: ReadonlyArray<string>
    readonly tools: ReadonlyArray<string>
    readonly result_format: ResultFormat | null
  }): Effect.Effect<{ readonly key: KeyRow; readonly token: string }>
  updateKey(id: string, patch: {
    readonly name?: string | undefined
    readonly groups?: ReadonlyArray<string> | undefined
    readonly tools?: ReadonlyArray<string> | undefined
    readonly enabled?: boolean | undefined
    /** `null` clears the override; `undefined` leaves it alone. */
    readonly result_format?: ResultFormat | null | undefined
  }): Effect.Effect<KeyRow | null>
  deleteKey(id: string): Effect.Effect<boolean>
  touchKey(id: string): Effect.Effect<void>

  readonly listGroups: Effect.Effect<Array<GroupRow>>
  getGroup(id: string): Effect.Effect<GroupRow | null>
  createGroup(group: GroupRow): Effect.Effect<GroupRow>
  updateGroup(id: string, patch: {
    readonly name?: string | undefined
    readonly description?: string | undefined
    readonly tools?: ReadonlyArray<string> | undefined
  }): Effect.Effect<GroupRow | null>
  deleteGroup(id: string): Effect.Effect<boolean>

  readonly listCustomTools: Effect.Effect<Array<CustomToolRow>>
  getCustomTool(name: string): Effect.Effect<CustomToolRow | null>
  createCustomTool(input: {
    readonly name: string
    readonly description: string
    readonly sql: string
    readonly params: ReadonlyArray<ToolParam>
    readonly allow_writes: boolean
  }): Effect.Effect<CustomToolRow>
  updateCustomTool(name: string, patch: {
    readonly description?: string | undefined
    readonly sql?: string | undefined
    readonly params?: ReadonlyArray<ToolParam> | undefined
    readonly allow_writes?: boolean | undefined
  }): Effect.Effect<CustomToolRow | null>
  deleteCustomTool(name: string): Effect.Effect<boolean>

  readonly getSettings: Effect.Effect<Settings>
  updateSettings(patch: Partial<Settings>): Effect.Effect<Settings>

  readonly countUsers: Effect.Effect<number>
  findUser(username: string): Effect.Effect<UserRow | null>
  createUser(input: { readonly username: string; readonly password_hash: string }): Effect.Effect<User>
  setPassword(userId: string, password_hash: string): Effect.Effect<void>

  /** Open a session and return its token. Only the token's hash is stored. */
  createSession(userId: string, lifetimeMs: number, client: string | null): Effect.Effect<string>
  /** The live session for a token, with its expiry pushed out by `lifetimeMs`. */
  touchSession(token: string, lifetimeMs: number): Effect.Effect<SessionRow | null>
  deleteSession(token: string): Effect.Effect<void>
  /** End every session of a user, optionally sparing one. */
  deleteSessionsOf(userId: string, exceptToken?: string): Effect.Effect<void>
  readonly pruneSessions: Effect.Effect<number>

  insertLog(entry: NewLog): Effect.Effect<void>
  listLogs(filter: LogFilter): Effect.Effect<Array<LogEntry>>
  getLog(id: number): Effect.Effect<LogEntry | null>
  stats(range: StatsRange): Effect.Effect<Stats>
  /** Drop log rows older than the retention window. Returns how many went. */
  readonly pruneLogs: Effect.Effect<number>
  readonly clearLogs: Effect.Effect<number>
}>()("postgres2mcp/Store") {
  static readonly layerNoDeps = Layer.effect(
    Store,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const config = yield* AppConfig

      const nowIso = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString())

      // ── keys ───────────────────────────────────────────────────────────────

      const keyFrom = (row: Record<string, unknown>): KeyRow => ({
        id: String(row.id),
        name: String(row.name),
        token_prefix: String(row.token_prefix),
        groups: parseList(row.groups),
        tools: parseList(row.tools),
        enabled: row.enabled === 1,
        created_at: String(row.created_at),
        last_used_at: row.last_used_at === null ? null : String(row.last_used_at),
        result_format: row.result_format === null ? null : row.result_format as ResultFormat
      })

      const listKeys = sql`SELECT * FROM api_keys ORDER BY created_at`.pipe(
        Effect.map((rows) => rows.map(keyFrom)),
        Effect.orDie
      )

      const getKey = (id: string) =>
        sql`SELECT * FROM api_keys WHERE id = ${id}`.pipe(
          Effect.map((rows) => (rows[0] ? keyFrom(rows[0]) : null)),
          Effect.orDie
        )

      const findKeyByToken = (token: string) =>
        sql`SELECT * FROM api_keys WHERE token_hash = ${hashToken(token)}`.pipe(
          Effect.map((rows) => (rows[0] ? keyFrom(rows[0]) : null)),
          Effect.orDie
        )

      const createKey = Effect.fn("Store.createKey")(function*(input: {
        readonly name: string
        readonly groups: ReadonlyArray<string>
        readonly tools: ReadonlyArray<string>
        readonly result_format: ResultFormat | null
      }) {
        const id = `key_${randomBytes(6).toString("hex")}`
        const token = `p2m_${randomBytes(24).toString("base64url")}`
        const created_at = yield* nowIso
        const token_prefix = token.slice(0, 10)
        yield* sql`
          INSERT INTO api_keys (id, name, token_hash, token_prefix, groups, tools, enabled, created_at, result_format)
          VALUES (${id}, ${input.name}, ${hashToken(token)}, ${token_prefix},
                  ${JSON.stringify(input.groups)}, ${JSON.stringify(input.tools)}, 1, ${created_at},
                  ${input.result_format})
        `.pipe(Effect.orDie)
        const key: KeyRow = {
          id,
          name: input.name,
          token_prefix,
          groups: [...input.groups],
          tools: [...input.tools],
          enabled: true,
          created_at,
          last_used_at: null,
          result_format: input.result_format
        }
        return { key, token }
      })

      const updateKey = Effect.fn("Store.updateKey")(function*(id: string, patch: {
        readonly name?: string | undefined
        readonly groups?: ReadonlyArray<string> | undefined
        readonly tools?: ReadonlyArray<string> | undefined
        readonly enabled?: boolean | undefined
        readonly result_format?: ResultFormat | null | undefined
      }) {
        const current = yield* getKey(id)
        if (current === null) return null
        const next: KeyRow = {
          ...current,
          name: patch.name ?? current.name,
          groups: patch.groups ?? current.groups,
          tools: patch.tools ?? current.tools,
          enabled: patch.enabled ?? current.enabled,
          result_format: patch.result_format === undefined ? current.result_format : patch.result_format
        }
        yield* sql`
          UPDATE api_keys
          SET name = ${next.name}, groups = ${JSON.stringify(next.groups)},
              tools = ${JSON.stringify(next.tools)}, enabled = ${next.enabled ? 1 : 0},
              result_format = ${next.result_format}
          WHERE id = ${id}
        `.pipe(Effect.orDie)
        return next
      })

      const deleteKey = (id: string) =>
        sql`DELETE FROM api_keys WHERE id = ${id} RETURNING id`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie
        )

      const touchKey = (id: string) =>
        Effect.flatMap(nowIso, (now) => sql`UPDATE api_keys SET last_used_at = ${now} WHERE id = ${id}`).pipe(
          Effect.asVoid,
          Effect.orDie
        )

      // ── groups ─────────────────────────────────────────────────────────────

      const groupFrom = (row: Record<string, unknown>): GroupRow => ({
        id: String(row.id),
        name: String(row.name),
        description: String(row.description),
        tools: parseList(row.tools)
      })

      const listGroups = sql`SELECT * FROM tool_groups ORDER BY created_at`.pipe(
        Effect.map((rows) => rows.map(groupFrom)),
        Effect.orDie
      )

      const getGroup = (id: string) =>
        sql`SELECT * FROM tool_groups WHERE id = ${id}`.pipe(
          Effect.map((rows) => (rows[0] ? groupFrom(rows[0]) : null)),
          Effect.orDie
        )

      const createGroup = Effect.fn("Store.createGroup")(function*(group: GroupRow) {
        const created_at = yield* nowIso
        yield* sql`
          INSERT INTO tool_groups (id, name, description, tools, created_at)
          VALUES (${group.id}, ${group.name}, ${group.description}, ${JSON.stringify(group.tools)}, ${created_at})
        `.pipe(Effect.orDie)
        return group
      })

      const updateGroup = Effect.fn("Store.updateGroup")(function*(id: string, patch: {
        readonly name?: string | undefined
        readonly description?: string | undefined
        readonly tools?: ReadonlyArray<string> | undefined
      }) {
        const current = yield* getGroup(id)
        if (current === null) return null
        const next: GroupRow = {
          id,
          name: patch.name ?? current.name,
          description: patch.description ?? current.description,
          tools: patch.tools ?? current.tools
        }
        yield* sql`
          UPDATE tool_groups
          SET name = ${next.name}, description = ${next.description}, tools = ${JSON.stringify(next.tools)}
          WHERE id = ${id}
        `.pipe(Effect.orDie)
        return next
      })

      const deleteGroup = (id: string) =>
        sql`DELETE FROM tool_groups WHERE id = ${id} RETURNING id`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie
        )

      // ── custom tools ───────────────────────────────────────────────────────

      const toolFrom = (row: Record<string, unknown>): CustomToolRow => ({
        name: String(row.name),
        description: String(row.description),
        sql: String(row.sql),
        params: parseJson<Array<ToolParam>>(row.params, []),
        allow_writes: row.allow_writes === 1,
        version: Number(row.version),
        created_at: String(row.created_at),
        updated_at: String(row.updated_at)
      })

      const listCustomTools = sql`SELECT * FROM custom_tools ORDER BY name`.pipe(
        Effect.map((rows) => rows.map(toolFrom)),
        Effect.orDie
      )

      const getCustomTool = (name: string) =>
        sql`SELECT * FROM custom_tools WHERE name = ${name}`.pipe(
          Effect.map((rows) => (rows[0] ? toolFrom(rows[0]) : null)),
          Effect.orDie
        )

      const createCustomTool = Effect.fn("Store.createCustomTool")(function*(input: {
        readonly name: string
        readonly description: string
        readonly sql: string
        readonly params: ReadonlyArray<ToolParam>
        readonly allow_writes: boolean
      }) {
        const now = yield* nowIso
        yield* sql`
          INSERT INTO custom_tools (name, description, sql, params, allow_writes, version, created_at, updated_at)
          VALUES (${input.name}, ${input.description}, ${input.sql}, ${JSON.stringify(input.params)},
                  ${input.allow_writes ? 1 : 0}, 1, ${now}, ${now})
        `.pipe(Effect.orDie)
        const tool: CustomToolRow = {
          name: input.name,
          description: input.description,
          sql: input.sql,
          params: [...input.params],
          allow_writes: input.allow_writes,
          version: 1,
          created_at: now,
          updated_at: now
        }
        return tool
      })

      const updateCustomTool = Effect.fn("Store.updateCustomTool")(function*(name: string, patch: {
        readonly description?: string | undefined
        readonly sql?: string | undefined
        readonly params?: ReadonlyArray<ToolParam> | undefined
        readonly allow_writes?: boolean | undefined
      }) {
        const current = yield* getCustomTool(name)
        if (current === null) return null
        const nextSql = patch.sql ?? current.sql
        const nextParams = patch.params ?? current.params
        const nextWrites = patch.allow_writes ?? current.allow_writes
        // What a caller can observe changed — bump the version.
        const changed = nextSql !== current.sql ||
          JSON.stringify(nextParams) !== JSON.stringify(current.params) ||
          nextWrites !== current.allow_writes
        const next: CustomToolRow = {
          ...current,
          description: patch.description ?? current.description,
          sql: nextSql,
          params: [...nextParams],
          allow_writes: nextWrites,
          version: changed ? current.version + 1 : current.version,
          updated_at: yield* nowIso
        }
        yield* sql`
          UPDATE custom_tools
          SET description = ${next.description}, sql = ${next.sql}, params = ${JSON.stringify(next.params)},
              allow_writes = ${next.allow_writes ? 1 : 0}, version = ${next.version}, updated_at = ${next.updated_at}
          WHERE name = ${name}
        `.pipe(Effect.orDie)
        return next
      })

      const deleteCustomTool = (name: string) =>
        sql`DELETE FROM custom_tools WHERE name = ${name} RETURNING name`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie
        )

      // ── settings ───────────────────────────────────────────────────────────

      const getSettings = sql`SELECT key, value FROM settings`.pipe(
        Effect.map((rows): Settings => {
          const stored = Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]))
          return {
            result_format: RESULT_FORMATS.has(stored.result_format ?? "")
              ? stored.result_format as ResultFormat
              : DEFAULT_SETTINGS.result_format
          }
        }),
        Effect.orDie
      )

      const updateSettings = Effect.fn("Store.updateSettings")(function*(patch: Partial<Settings>) {
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) continue
          yield* sql`
            INSERT INTO settings (key, value) VALUES (${key}, ${String(value)})
            ON CONFLICT (key) DO UPDATE SET value = excluded.value
          `.pipe(Effect.orDie)
        }
        return yield* getSettings
      })

      // ── accounts ───────────────────────────────────────────────────────────

      const countUsers = sql`SELECT COUNT(*) AS n FROM users`.pipe(
        Effect.map((rows) => Number(rows[0]?.n ?? 0)),
        Effect.orDie
      )

      const findUser = (username: string) =>
        sql`SELECT * FROM users WHERE username = ${username} COLLATE NOCASE`.pipe(
          Effect.map((rows): UserRow | null =>
            rows[0]
              ? {
                id: String(rows[0].id),
                username: String(rows[0].username),
                created_at: String(rows[0].created_at),
                password_hash: String(rows[0].password_hash)
              }
              : null
          ),
          Effect.orDie
        )

      const createUser = Effect.fn("Store.createUser")(function*(input: {
        readonly username: string
        readonly password_hash: string
      }) {
        const user: User = {
          id: `user_${randomBytes(6).toString("hex")}`,
          username: input.username,
          created_at: yield* nowIso
        }
        yield* sql`
          INSERT INTO users (id, username, password_hash, created_at)
          VALUES (${user.id}, ${user.username}, ${input.password_hash}, ${user.created_at})
        `.pipe(Effect.orDie)
        return user
      })

      const setPassword = (userId: string, password_hash: string) =>
        sql`UPDATE users SET password_hash = ${password_hash} WHERE id = ${userId}`.pipe(Effect.asVoid, Effect.orDie)

      const createSession = Effect.fn("Store.createSession")(function*(
        userId: string,
        lifetimeMs: number,
        client: string | null
      ) {
        const token = `p2ms_${randomBytes(32).toString("base64url")}`
        const now = yield* Clock.currentTimeMillis
        yield* sql`
          INSERT INTO sessions (token_hash, user_id, created_at, expires_at, client)
          VALUES (${hashToken(token)}, ${userId}, ${now}, ${now + lifetimeMs}, ${clip(client, 300)})
        `.pipe(Effect.orDie)
        return token
      })

      const touchSession = Effect.fn("Store.touchSession")(function*(token: string, lifetimeMs: number) {
        const now = yield* Clock.currentTimeMillis
        const rows = yield* sql`
          UPDATE sessions SET expires_at = ${now + lifetimeMs}
          WHERE token_hash = ${hashToken(token)} AND expires_at > ${now}
          RETURNING user_id, expires_at
        `.pipe(Effect.orDie)
        const session = rows[0]
        if (!session) return null
        const users = yield* sql`SELECT username FROM users WHERE id = ${String(session.user_id)}`.pipe(Effect.orDie)
        if (!users[0]) return null
        const row: SessionRow = {
          user_id: String(session.user_id),
          username: String(users[0].username),
          expires_at: Number(session.expires_at)
        }
        return row
      })

      const deleteSession = (token: string) =>
        sql`DELETE FROM sessions WHERE token_hash = ${hashToken(token)}`.pipe(Effect.asVoid, Effect.orDie)

      const deleteSessionsOf = (userId: string, exceptToken?: string) =>
        (exceptToken === undefined
          ? sql`DELETE FROM sessions WHERE user_id = ${userId}`
          : sql`DELETE FROM sessions WHERE user_id = ${userId} AND token_hash != ${hashToken(exceptToken)}`).pipe(
            Effect.asVoid,
            Effect.orDie
          )

      const pruneSessions = Effect.flatMap(Clock.currentTimeMillis, (now) =>
        sql`DELETE FROM sessions WHERE expires_at <= ${now} RETURNING token_hash`).pipe(
          Effect.map((rows) => rows.length),
          Effect.orDie
        )

      // ── logs ───────────────────────────────────────────────────────────────

      const logFrom = (row: Record<string, unknown>): LogEntry => ({
        id: Number(row.id),
        ts: new Date(Number(row.ts)).toISOString(),
        source: row.source as LogSource,
        key_id: nullableString(row.key_id),
        key_name: nullableString(row.key_name),
        tool: String(row.tool),
        kind: row.kind as LogEntry["kind"],
        status: row.status as LogStatus,
        duration_ms: Number(row.duration_ms),
        row_count: row.row_count === null ? null : Number(row.row_count),
        error: nullableString(row.error),
        args: nullableString(row.args),
        sql: nullableString(row.sql),
        client: nullableString(row.client)
      })

      const insertLog = (entry: NewLog) =>
        Effect.flatMap(Clock.currentTimeMillis, (ts) =>
          sql`
            INSERT INTO logs (ts, source, key_id, key_name, tool, kind, status, duration_ms, row_count, error, args, sql, client)
            VALUES (${ts}, ${entry.source}, ${entry.key_id}, ${entry.key_name}, ${entry.tool}, ${entry.kind},
                    ${entry.status}, ${entry.duration_ms}, ${entry.row_count}, ${clip(entry.error, 4_000)},
                    ${clip(entry.args, 8_000)}, ${clip(entry.sql, 20_000)}, ${clip(entry.client, 300)})
          `).pipe(Effect.asVoid, Effect.orDie)

      const listLogs = (filter: LogFilter) => {
        const clauses = [sql`1 = 1`]
        if (filter.before !== undefined) clauses.push(sql`id < ${filter.before}`)
        if (filter.tool) clauses.push(sql`tool = ${filter.tool}`)
        if (filter.key_id) clauses.push(sql`key_id = ${filter.key_id}`)
        if (filter.status) clauses.push(sql`status = ${filter.status}`)
        if (filter.source) clauses.push(sql`source = ${filter.source}`)
        if (filter.q) {
          const like = `%${filter.q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
          clauses.push(sql`(
            tool LIKE ${like} ESCAPE '\\' OR sql LIKE ${like} ESCAPE '\\' OR
            args LIKE ${like} ESCAPE '\\' OR error LIKE ${like} ESCAPE '\\' OR key_name LIKE ${like} ESCAPE '\\'
          )`)
        }
        const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 100), 1), 501)
        return sql`SELECT * FROM logs WHERE ${sql.and(clauses)} ORDER BY id DESC LIMIT ${limit}`.pipe(
          Effect.map((rows) => rows.map(logFrom)),
          Effect.orDie
        )
      }

      const getLog = (id: number) =>
        sql`SELECT * FROM logs WHERE id = ${id}`.pipe(
          Effect.map((rows) => (rows[0] ? logFrom(rows[0]) : null)),
          Effect.orDie
        )

      const stats = Effect.fn("Store.stats")(function*(range: StatsRange) {
        const { bucketMs, buckets } = RANGES[range]
        const now = yield* Clock.currentTimeMillis
        // Align to bucket boundaries so the chart's bars don't drift as time passes.
        const lastBucket = Math.floor(now / bucketMs) * bucketMs
        const from = lastBucket - (buckets - 1) * bucketMs

        const totalsRows = yield* sql`
          SELECT COUNT(*) AS calls,
                 COALESCE(SUM(status = 'ok'), 0) AS ok,
                 COALESCE(SUM(status = 'error'), 0) AS errors,
                 COALESCE(SUM(status = 'denied'), 0) AS denied,
                 COALESCE(SUM(row_count), 0) AS rows,
                 COALESCE(AVG(CASE WHEN status != 'denied' THEN duration_ms END), 0) AS avg_ms,
                 COALESCE(SUM(status != 'denied'), 0) AS executed
          FROM logs WHERE ts >= ${from}
        `.pipe(Effect.orDie)
        const totals = totalsRows[0] ?? {}
        const executed = Number(totals.executed ?? 0)

        const p95Rows = executed === 0 ? [] : yield* sql`
          SELECT duration_ms FROM logs
          WHERE ts >= ${from} AND status != 'denied'
          ORDER BY duration_ms
          LIMIT 1 OFFSET ${Math.min(executed - 1, Math.floor(executed * 0.95))}
        `.pipe(Effect.orDie)

        const seriesRows = yield* sql`
          SELECT CAST(ts / ${bucketMs} AS INTEGER) * ${bucketMs} AS bucket,
                 COALESCE(SUM(status = 'ok'), 0) AS ok,
                 COALESCE(SUM(status = 'error'), 0) AS errors,
                 COALESCE(SUM(status = 'denied'), 0) AS denied,
                 COALESCE(AVG(CASE WHEN status != 'denied' THEN duration_ms END), 0) AS avg_ms
          FROM logs WHERE ts >= ${from}
          GROUP BY bucket
        `.pipe(Effect.orDie)
        const byBucket = new Map(seriesRows.map((row) => [Number(row.bucket), row]))
        const series = Array.from({ length: buckets }, (_, index) => {
          const t = from + index * bucketMs
          const row = byBucket.get(t)
          return {
            t: new Date(t).toISOString(),
            ok: Number(row?.ok ?? 0),
            errors: Number(row?.errors ?? 0),
            denied: Number(row?.denied ?? 0),
            avg_ms: round(Number(row?.avg_ms ?? 0))
          }
        })

        const toolRows = yield* sql`
          SELECT tool, COUNT(*) AS calls, COALESCE(SUM(status = 'error'), 0) AS errors,
                 COALESCE(AVG(duration_ms), 0) AS avg_ms
          FROM logs WHERE ts >= ${from}
          GROUP BY tool ORDER BY calls DESC, tool LIMIT 12
        `.pipe(Effect.orDie)

        const keyRows = yield* sql`
          SELECT key_id, COALESCE(MAX(key_name), CASE source WHEN 'stdio' THEN 'stdio' ELSE 'admin' END) AS key_name,
                 COUNT(*) AS calls, COALESCE(SUM(status = 'error'), 0) AS errors
          FROM logs WHERE ts >= ${from}
          GROUP BY key_id, CASE WHEN key_id IS NULL THEN source END
          ORDER BY calls DESC, key_name LIMIT 12
        `.pipe(Effect.orDie)

        const result: Stats = {
          range,
          bucket_seconds: bucketMs / 1000,
          totals: {
            calls: Number(totals.calls ?? 0),
            ok: Number(totals.ok ?? 0),
            errors: Number(totals.errors ?? 0),
            denied: Number(totals.denied ?? 0),
            rows: Number(totals.rows ?? 0),
            avg_ms: round(Number(totals.avg_ms ?? 0)),
            p95_ms: round(Number(p95Rows[0]?.duration_ms ?? 0))
          },
          series,
          by_tool: toolRows.map((row) => ({
            tool: String(row.tool),
            calls: Number(row.calls),
            errors: Number(row.errors),
            avg_ms: round(Number(row.avg_ms))
          })),
          by_key: keyRows.map((row) => ({
            key_id: nullableString(row.key_id),
            key_name: String(row.key_name),
            calls: Number(row.calls),
            errors: Number(row.errors)
          }))
        }
        return result
      })

      const pruneLogs = Effect.gen(function*() {
        if (config.logRetentionDays <= 0) return 0
        const cutoff = (yield* Clock.currentTimeMillis) - config.logRetentionDays * 86_400_000
        const rows = yield* sql`DELETE FROM logs WHERE ts < ${cutoff} RETURNING id`.pipe(Effect.orDie)
        return rows.length
      })

      const clearLogs = sql`DELETE FROM logs RETURNING id`.pipe(
        Effect.map((rows) => rows.length),
        Effect.orDie
      )

      return Store.of({
        listKeys,
        getKey,
        findKeyByToken,
        createKey,
        updateKey,
        deleteKey,
        touchKey,
        listGroups,
        getGroup,
        createGroup,
        updateGroup,
        deleteGroup,
        listCustomTools,
        getCustomTool,
        createCustomTool,
        updateCustomTool,
        deleteCustomTool,
        getSettings,
        updateSettings,
        countUsers,
        findUser,
        createUser,
        setPassword,
        createSession,
        touchSession,
        deleteSession,
        deleteSessionsOf,
        pruneSessions,
        insertLog,
        listLogs,
        getLog,
        stats,
        pruneLogs,
        clearLogs
      })
    })
  )

  /** The store on its SQLite file under the configured data directory. */
  static readonly layer = Layer.unwrap(
    Effect.gen(function*() {
      const config = yield* AppConfig
      const memory = config.dataDir === ":memory:"
      if (!memory) mkdirSync(config.dataDir, { recursive: true })
      const SqlLive = SqliteClient.layer({
        filename: memory ? ":memory:" : join(config.dataDir, "postgres2mcp.db")
      })
      return Store.layerNoDeps.pipe(
        Layer.provide(MigratorLayer.pipe(Layer.provideMerge(SqlLive))),
        Layer.orDie
      )
    })
  )
}

const MigratorLayer = SqliteMigrator.layer({
  loader: SqliteMigrator.fromRecord({
    "0001_initial": Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        CREATE TABLE api_keys (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          token_prefix TEXT NOT NULL,
          groups TEXT NOT NULL DEFAULT '[]',
          tools TEXT NOT NULL DEFAULT '[]',
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          last_used_at TEXT
        )
      `
      yield* sql`
        CREATE TABLE tool_groups (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          tools TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL
        )
      `
      yield* sql`
        CREATE TABLE saved_queries (
          name TEXT PRIMARY KEY,
          description TEXT NOT NULL DEFAULT '',
          sql TEXT NOT NULL,
          params TEXT NOT NULL DEFAULT '[]',
          allow_writes INTEGER NOT NULL DEFAULT 0,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `
      yield* sql`
        CREATE TABLE logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          source TEXT NOT NULL,
          key_id TEXT,
          key_name TEXT,
          tool TEXT NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          duration_ms REAL NOT NULL,
          row_count INTEGER,
          error TEXT,
          args TEXT,
          sql TEXT,
          client TEXT
        )
      `
      yield* sql`CREATE INDEX logs_ts ON logs (ts)`
      yield* sql`CREATE INDEX logs_tool ON logs (tool, ts)`
      yield* sql`CREATE INDEX logs_key ON logs (key_id, ts)`
    }),
    // Saved queries became custom tools; accounts replaced the admin token;
    // result formats arrived (a server default, and a per-key override).
    "0002_custom_tools_accounts_settings": Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`ALTER TABLE saved_queries RENAME TO custom_tools`
      yield* sql`UPDATE logs SET kind = 'custom' WHERE kind = 'query'`
      yield* sql`UPDATE api_keys SET groups = REPLACE(groups, '"queries"', '"custom"')`
      yield* sql`ALTER TABLE api_keys ADD COLUMN result_format TEXT`
      yield* sql`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
      yield* sql`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE COLLATE NOCASE,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `
      yield* sql`
        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          client TEXT
        )
      `
      yield* sql`CREATE INDEX sessions_user ON sessions (user_id)`
    })
  })
})

export const DEFAULT_SETTINGS: Settings = { result_format: "compact" }

const RESULT_FORMATS = new Set<string>(["compact", "objects", "markdown", "csv"])

const RANGES: Record<StatsRange, { readonly bucketMs: number; readonly buckets: number }> = {
  "1h": { bucketMs: 60_000, buckets: 60 },
  "24h": { bucketMs: 3_600_000, buckets: 24 },
  "7d": { bucketMs: 6 * 3_600_000, buckets: 28 },
  "30d": { bucketMs: 86_400_000, buckets: 30 }
}

/** Only the hash is stored; a leaked state file does not leak working tokens. */
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex")

const round = (value: number) => Math.round(value * 100) / 100

const nullableString = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))

const clip = (value: string | null, max: number): string | null =>
  value !== null && value.length > max ? `${value.slice(0, max)}… [truncated]` : value

function parseJson<A>(value: unknown, fallback: A): A {
  if (typeof value !== "string") return fallback
  try {
    return JSON.parse(value) as A
  } catch {
    return fallback
  }
}

const parseList = (value: unknown): Array<string> =>
  parseJson<Array<unknown>>(value, []).filter((item): item is string => typeof item === "string")
