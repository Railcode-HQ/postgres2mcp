// The one door to the target database. Every statement — built-in tool, saved
// query, or arbitrary SQL — goes through `run`, so the guardrails live here:
//
//   * one statement per call (the extended protocol rejects batches, and the
//     lexical check in the tool layer rejects them earlier with a better message)
//   * a transaction per call, READ ONLY unless the tool is allowed to write
//   * a server-side statement timeout
//   * a row cap and a byte cap on what comes back
import { Context, Effect, Exit, Layer } from "effect"
import pg from "pg"
import { parse as parseConnectionString, toClientConfig } from "pg-connection-string"
import Cursor from "pg-cursor"
import type { QueryResult } from "../domain.ts"
import { QueryError } from "../errors.ts"
import { segments } from "../sql/sqltext.ts"
import { AppConfig } from "./AppConfig.ts"

export interface RunOptions {
  /** Run inside `BEGIN TRANSACTION READ ONLY` and roll back afterwards. */
  readonly readOnly: boolean
  /** Skip the transaction entirely — only for commands like VACUUM that refuse one. */
  readonly noTransaction?: boolean
}

export interface DatabaseInfo {
  readonly name: string
  readonly user: string
  readonly host: string | null
  readonly server_version: string
}

export class Pg extends Context.Service<Pg, {
  run(sql: string, params: ReadonlyArray<unknown>, options: RunOptions): Effect.Effect<QueryResult, QueryError>
  readonly info: Effect.Effect<DatabaseInfo, QueryError>
}>()("postgres2mcp/Pg") {
  static readonly layer = Layer.effect(
    Pg,
    Effect.gen(function*() {
      const config = yield* AppConfig
      const clientConfig = connectionConfig(config.databaseUrl)

      const pool = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const pool = new pg.Pool({
            ...clientConfig,
            max: config.poolSize,
            connectionTimeoutMillis: 10_000,
            idleTimeoutMillis: 30_000,
            application_name: clientConfig.application_name ?? "postgres2mcp",
            types: typeParsers
          })
          // An idle client dropping (database restart, network blip) must not
          // take the process down; the pool replaces it on the next checkout.
          pool.on("error", () => {})
          return pool
        }),
        (pool) => Effect.promise(() => pool.end())
      )

      const send = (client: pg.PoolClient, text: string, values?: Array<unknown>) =>
        Effect.tryPromise({
          try: () => client.query(text, values),
          catch: toQueryError
        })

      // pg_settings exposes statement_timeout in milliseconds, regardless of
      // the units used by ALTER ROLE or connection options. Zero disables a
      // timeout, so keep the smaller nonzero limit (or zero if both are off).
      const setStatementTimeout = (client: pg.PoolClient, local: boolean) =>
        send(client, `
          SELECT set_config('statement_timeout',
            COALESCE(LEAST(NULLIF(setting::int, 0), NULLIF($1::int, 0)), 0)::text, $2)
          FROM pg_settings WHERE name = 'statement_timeout'
        `, [config.queryTimeoutMs, local])

      const withClient = <A>(use: (client: pg.PoolClient) => Effect.Effect<A, QueryError>) =>
        Effect.acquireUseRelease(
          Effect.tryPromise({ try: () => pool.connect(), catch: toQueryError }),
          use,
          (client, exit) => Effect.promise(async () => {
            if (Exit.isFailure(exit)) {
              client.release(true)
              return
            }
            // ROLLBACK alone leaves session advisory locks behind. Reset all
            // session state before reuse, including successful write calls.
            // If cleanup fails or stalls, discard the connection instead.
            try {
              const cleanup = { text: "DISCARD ALL", query_timeout: 1000 }
              await client.query(cleanup)
              client.release()
            } catch {
              client.release(true)
            }
          })
        )

      const readCapped = (client: pg.PoolClient, sql: string, params: ReadonlyArray<unknown>) =>
        Effect.tryPromise({
          try: () =>
            new Promise<Fetched>((resolve, reject) => {
              const cursor = client.query(new Cursor(sql, [...params], { rowMode: "array", types: typeParsers }))
              // One past the cap, so "exactly max rows" and "more than max rows" differ.
              cursor.read(config.maxRows + 1, (error, rows, result) => {
                if (error) {
                  reject(error)
                  return
                }
                cursor.close(() => resolve({ rows: rows as Array<Array<unknown>>, result }))
              })
            }),
          catch: toQueryError
        })

      const shape = (fetched: Fetched, started: number): QueryResult => {
        const columns = (fetched.result?.fields ?? []).map((field) => field.name)
        const rows: Array<Array<unknown>> = []
        let truncated = false
        let bytes = 0
        for (const raw of fetched.rows) {
          if (rows.length >= config.maxRows) {
            truncated = true
            break
          }
          const row = raw.map(normalize)
          bytes += Buffer.byteLength(JSON.stringify(row), "utf8")
          if (bytes > config.maxBytes) {
            truncated = true
            break
          }
          rows.push(row)
        }
        const command = fetched.result?.command ?? null
        return {
          columns,
          rows,
          // A statement with no result set reports the rows it affected instead.
          row_count: columns.length > 0 ? rows.length : fetched.result?.rowCount ?? 0,
          truncated,
          command: command === "" ? null : command,
          duration_ms: elapsedSince(started)
        }
      }

      const run = Effect.fn("Pg.run")(function*(sql: string, params: ReadonlyArray<unknown>, options: RunOptions) {
        const started = performance.now()

        // COPY uses a separate wire protocol that pg-cursor cannot handle.
        // Refuse it before the driver can receive an unsupported COPY message.
        if (isCopyStatement(sql)) {
          return yield* new QueryError({
            message: "COPY is not supported. Use SELECT to read rows or INSERT to write them.",
            code: "0A000"
          })
        }

        if (options.noTransaction) {
          return yield* withClient((client) =>
            Effect.gen(function*() {
              const previousTimeout = (yield* send(client, "SHOW statement_timeout")).rows[0].statement_timeout
              yield* setStatementTimeout(client, false)
              const result = yield* Effect.tryPromise({
                try: () => client.query({ text: sql, values: [...params], rowMode: "array" }),
                catch: toQueryError
              })
              // Restore successful clients; withClient destroys failed or interrupted ones.
              yield* send(client, "SELECT set_config('statement_timeout', $1, false)", [previousTimeout])
              return shape({ rows: (result.rows ?? []) as Array<Array<unknown>>, result }, started)
            })
          )
        }

        return yield* withClient((client) =>
          Effect.gen(function*() {
            yield* send(client, options.readOnly ? "BEGIN TRANSACTION READ ONLY" : "BEGIN")
            const fetched = yield* Effect.gen(function*() {
              // A SELECT, so it also takes the transaction's first snapshot —
              // after which Postgres refuses to flip a read-only transaction
              // back to read-write.
              yield* setStatementTimeout(client, true)
              return yield* readCapped(client, sql, params)
            }).pipe(
              Effect.onError(() => Effect.ignore(send(client, "ROLLBACK")))
            )
            // Read-only work has nothing to keep; a write must commit, and a
            // failing COMMIT (deferred constraint) is the caller's error to see.
            yield* options.readOnly
              ? Effect.ignore(send(client, "ROLLBACK"))
              : send(client, "COMMIT")
            return shape(fetched, started)
          })
        ).pipe(
          Effect.mapError((error) => explain(error, options))
        )
      })

      const info = run(
        "SELECT current_database(), current_user, inet_server_addr()::text, current_setting('server_version')",
        [],
        { readOnly: true }
      ).pipe(
        Effect.map((result): DatabaseInfo => {
          const row = result.rows[0] ?? []
          return {
            name: String(row[0] ?? ""),
            user: String(row[1] ?? ""),
            host: clientConfig.host ?? (row[2] === null || row[2] === undefined ? null : String(row[2])),
            server_version: String(row[3] ?? "")
          }
        })
      )

      return Pg.of({ run, info })
    })
  )
}

interface Fetched {
  readonly rows: Array<Array<unknown>>
  readonly result: pg.QueryResult | undefined
}

const elapsedSince = (started: number) => Math.round((performance.now() - started) * 100) / 100

/** Find the leading command, ignoring comments (including custom-tool labels). */
function isCopyStatement(sql: string): boolean {
  for (const segment of segments(sql)) {
    if (segment.kind === "lineComment" || segment.kind === "blockComment") continue
    if (segment.kind !== "code") return false
    const text = sql.slice(segment.start, segment.end).replace(/^[\s;]+/, "")
    if (text !== "") return /^COPY\b/i.test(text)
  }
  return false
}

/**
 * Parse the connection string with libpq semantics, so a URL copied from a
 * hosted provider (`sslmode=require`) encrypts without demanding a CA bundle —
 * the same thing `psql` does with it.
 */
export function connectionConfig(url: string): pg.ClientConfig {
  const explicit = /[?&]uselibpqcompat=/.test(url)
  return toClientConfig(parseConnectionString(systemRoots(url), explicit ? {} : { useLibpqCompat: true }))
}

/**
 * `sslrootcert=system` is libpq's name for the public CAs, and it implies
 * `verify-full`. The parser would open a file called "system"; verifying
 * against the runtime's own CA list is what `verify-full` alone does.
 */
function systemRoots(url: string): string {
  const query = url.indexOf("?")
  if (query === -1) return url
  const params = url.slice(query + 1).split("&")
  if (!params.includes("sslrootcert=system")) return url
  const kept = params.filter((param) => param !== "sslrootcert=system" && !param.startsWith("sslmode="))
  return `${url.slice(0, query)}?${[...kept, "sslmode=verify-full"].join("&")}`
}

// ── values ───────────────────────────────────────────────────────────────────
// Results are read by a model, so they should say what Postgres said. Temporal
// types stay as the text Postgres rendered (no silent timezone shift through
// `Date`), and numerics become JSON numbers only when that loses nothing.

const OID = {
  bytea: 17,
  int8: 20,
  date: 1082,
  time: 1083,
  timestamp: 1114,
  timestamptz: 1184,
  interval: 1186,
  timetz: 1266,
  numeric: 1700,
  numericArray: 1231,
  textArray: 1009
} as const

const RAW_TEXT = new Set<number>([
  OID.bytea,
  OID.date,
  OID.time,
  OID.timestamp,
  OID.timestamptz,
  OID.interval,
  OID.timetz
])

const identity = (value: string) => value

/** A float64 holds 15 significant decimal digits exactly; beyond that, keep the text. */
const exactNumber = (value: string): number | string => {
  const digits = value.replace(/^-/, "").replace(".", "").replace(/^0+/, "")
  return /^-?\d+(\.\d+)?$/.test(value) && digits.length <= 15 ? Number(value) : value
}

const safeInteger = (value: string): number | string => {
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : value
}

// Parse the array's structure without first rounding its numeric elements.
// The text-array parser also handles NULLs, dimensions and nested arrays.
type TextArray = Array<string | null | TextArray>
// pg-types' TypeId enum omits array OIDs, though the driver supports them.
const parseTextArray: (value: string) => TextArray = pg.types.getTypeParser(OID.textArray as number, "text")
const exactNumbers = (values: TextArray): Array<unknown> =>
  values.map((value) => Array.isArray(value) ? exactNumbers(value) : value === null ? null : exactNumber(value))
const parseNumericArray = (value: string) => exactNumbers(parseTextArray(value))

const typeParsers: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: "text" | "binary") => {
    if (format === "binary") return pg.types.getTypeParser(oid, "binary")
    if (RAW_TEXT.has(oid)) return identity
    if (oid === OID.int8) return safeInteger
    if (oid === OID.numeric) return exactNumber
    if (oid === OID.numericArray) return parseNumericArray
    return pg.types.getTypeParser(oid, "text")
  }) as pg.CustomTypesConfig["getTypeParser"]
}

/** Make a parsed value JSON-safe (array elements still arrive as Date/Buffer). */
function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (Buffer.isBuffer(value)) return `\\x${value.toString("hex")}`
  if (typeof value === "bigint") return value.toString()
  if (Array.isArray(value)) return value.map(normalize)
  return value
}

// ── errors ───────────────────────────────────────────────────────────────────

function toQueryError(cause: unknown): QueryError {
  if (cause instanceof QueryError) return cause
  // Node reports a refused dual-stack connect as an AggregateError with no message.
  const inner = cause instanceof AggregateError && cause.errors.length > 0 ? cause.errors[0] : cause
  const error = (inner ?? {}) as {
    message?: unknown
    code?: unknown
    detail?: unknown
    hint?: unknown
    position?: unknown
  }
  const message = typeof error.message === "string" && error.message !== "" ? error.message : String(inner)
  const position = typeof error.position === "string" ? Number.parseInt(error.position, 10) : undefined
  return new QueryError({
    message,
    ...(typeof error.code === "string" ? { code: error.code } : {}),
    ...(typeof error.detail === "string" ? { detail: error.detail } : {}),
    ...(typeof error.hint === "string" ? { hint: error.hint } : {}),
    ...(position !== undefined && Number.isInteger(position) ? { position } : {})
  })
}

/** Add the hint a caller needs to recover from the errors this layer provokes. */
function explain(error: QueryError, options: RunOptions): QueryError {
  if (error.code === "25006" && options.readOnly) {
    return new QueryError({ ...fields(error), hint: "This call is read-only. Writing needs a tool that allows writes." })
  }
  if (error.code === "42601" && /multiple commands/.test(error.message)) {
    return new QueryError({ ...fields(error), message: "Only a single SQL statement is allowed per call" })
  }
  return error
}

const fields = (error: QueryError) => ({
  message: error.message,
  ...(error.code !== undefined ? { code: error.code } : {}),
  ...(error.detail !== undefined ? { detail: error.detail } : {}),
  ...(error.hint !== undefined ? { hint: error.hint } : {}),
  ...(error.position !== undefined ? { position: error.position } : {})
})
