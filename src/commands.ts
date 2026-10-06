// What the binary can do, all of it on the server's own machine: `serve` and
// `stdio` run postgres2mcp, and `reset-password` opens its state directly for
// an admin who is locked out. Everything else is done in the dashboard, or by
// an MCP client.
import { Config, Console, Effect, Layer, Logger, Option, Redacted, Schema, Stdio, Stream } from "effect"
import { Argument, Command, Flag, Prompt } from "effect/cli"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { HttpLayer, ServicesLayer } from "./server.ts"
import { AppConfig, DEFAULTS } from "./services/AppConfig.ts"
import { Auth } from "./services/Auth.ts"
import { Mcp, type McpReply } from "./services/Mcp.ts"
import { Pg } from "./services/Pg.ts"
import { Store } from "./services/Store.ts"
import type { Caller } from "./services/Tools.ts"
import { VERSION } from "./version.ts"

/** The command could not do what was asked. The message is the whole story. */
export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  message: Schema.String
}) {}

/** Split a comma-separated flag value into trimmed, non-empty parts. */
const list = (value: string): Array<string> => value.split(",").map((part) => part.trim()).filter((part) => part !== "")

// ── flags (each falls back to an environment variable) ───────────────────────

const databaseUrl = Flag.String("database-url").pipe(
  Flag.withAlias("d"),
  Flag.withDescription("Postgres connection string of the database to expose [env: DATABASE_URL]"),
  Flag.withFallbackConfig(Config.String("DATABASE_URL")),
  Flag.optional
)

const dataDir = Flag.String("data-dir").pipe(
  Flag.withDescription("Where postgres2mcp keeps its own state (accounts, keys, custom tools, logs) [env: P2M_DATA_DIR]"),
  Flag.withFallbackConfig(Config.String("P2M_DATA_DIR")),
  Flag.withDefault(DEFAULTS.dataDir)
)

const limits = {
  maxRows: Flag.Int("max-rows").pipe(
    Flag.withDescription("Row cap on every result set [env: P2M_MAX_ROWS]"),
    Flag.withFallbackConfig(Config.Int("P2M_MAX_ROWS")),
    Flag.withDefault(DEFAULTS.maxRows)
  ),
  queryTimeoutMs: Flag.Int("query-timeout-ms").pipe(
    Flag.withDescription("Statement timeout in milliseconds [env: P2M_QUERY_TIMEOUT_MS]"),
    Flag.withFallbackConfig(Config.Int("P2M_QUERY_TIMEOUT_MS")),
    Flag.withDefault(DEFAULTS.queryTimeoutMs)
  ),
  logRetentionDays: Flag.Int("log-retention-days").pipe(
    Flag.withDescription("Days of call logs to keep, 0 for forever [env: P2M_LOG_RETENTION_DAYS]"),
    Flag.withFallbackConfig(Config.Int("P2M_LOG_RETENTION_DAYS")),
    Flag.withDefault(DEFAULTS.logRetentionDays)
  )
}

const requireDatabaseUrl = (value: Option.Option<string>) =>
  Option.match(value, {
    onNone: () =>
      Effect.fail(
        new UsageError({
          message:
            "No database to expose. Set DATABASE_URL or pass --database-url postgres://user:pass@host:5432/db"
        })
      ),
    onSome: (url) => Effect.succeed(url)
  })

/** `https://mcp.example.com/` → `https://mcp.example.com`; anything that is not an http(s) URL is refused. */
const parsePublicUrl = (value: string): Effect.Effect<string | null, UsageError> => {
  const text = value.trim()
  if (text === "") return Effect.succeed(null)
  const url = URL.canParse(text) ? new URL(text) : null
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return Effect.fail(
      new UsageError({ message: `P2M_PUBLIC_URL must be an http(s) URL such as https://mcp.example.com, not "${text}"` })
    )
  }
  return Effect.succeed(`${url.origin}${url.pathname.replace(/\/+$/, "")}`)
}

/**
 * The built dashboard. P2M_WEB_DIR, when set, is the only place looked at (so
 * pointing it somewhere empty runs without one); otherwise the build next to
 * the source, or under the working directory, is picked up if it exists.
 */
const findWebDir = (): string | null => {
  const hasBuild = (dir: string) => existsSync(join(dir, "index.html"))
  const explicit = process.env.P2M_WEB_DIR
  if (explicit !== undefined && explicit !== "") return hasBuild(explicit) ? resolve(explicit) : null
  for (const candidate of [join(import.meta.dir, "../web/dist"), join(process.cwd(), "web/dist")]) {
    if (hasBuild(candidate)) return resolve(candidate)
  }
  return null
}

// ── serve ────────────────────────────────────────────────────────────────────

const Banner = Layer.effectDiscard(Effect.gen(function*() {
  const config = yield* AppConfig
  const pg = yield* Pg
  const auth = yield* Auth
  const origin = config.publicUrl ?? `http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`
  const database = yield* pg.info.pipe(
    Effect.map((info) => `${info.user}@${info.host ?? "local"}/${info.name} (PostgreSQL ${info.server_version})`),
    Effect.catch((error) => Effect.succeed(`NOT CONNECTED — ${error.message}`))
  )
  const setupRequired = yield* auth.setupRequired
  yield* Console.log(
    [
      "",
      `  postgres2mcp ${VERSION}`,
      "",
      `  Dashboard    ${config.webDir === null ? "(no build found — run `bun run build:web`)" : origin}`,
      `  MCP          ${origin}/mcp`,
      `  Database     ${database}`,
      `  State        ${resolve(config.dataDir)}`,
      ...(!setupRequired
        ? []
        : config.setupToken === null
        ? ["", "  No admin account yet. The first person to open the dashboard creates it."]
        : ["", "  No admin account yet. Create it here:", `  ${origin}/?setup=${encodeURIComponent(config.setupToken)}`]),
      ""
    ].join("\n")
  )
}))

export const serve = Command.make(
  "serve",
  {
    databaseUrl,
    dataDir,
    port: Flag.Int("port").pipe(
      Flag.withAlias("p"),
      Flag.withDescription("Port to listen on [env: PORT]"),
      Flag.withFallbackConfig(Config.Int("PORT")),
      Flag.withDefault(DEFAULTS.port)
    ),
    host: Flag.String("host").pipe(
      Flag.withDescription("Interface to bind [env: HOST]"),
      Flag.withFallbackConfig(Config.String("HOST")),
      Flag.withDefault(DEFAULTS.host)
    ),
    adminUsername: Flag.String("admin-username").pipe(
      Flag.withDescription("Create this admin account at startup if no account exists yet [env: P2M_ADMIN_USERNAME]"),
      Flag.withFallbackConfig(Config.String("P2M_ADMIN_USERNAME")),
      Flag.optional
    ),
    adminPassword: Flag.String("admin-password").pipe(
      Flag.withDescription("Password for --admin-username [env: P2M_ADMIN_PASSWORD]"),
      Flag.withFallbackConfig(Config.String("P2M_ADMIN_PASSWORD")),
      Flag.optional
    ),
    setupToken: Flag.String("setup-token").pipe(
      Flag.withDescription("Require this code to create the first account in the dashboard [env: P2M_SETUP_TOKEN]"),
      Flag.withFallbackConfig(Config.String("P2M_SETUP_TOKEN")),
      Flag.optional
    ),
    publicUrl: Flag.String("public-url").pipe(
      Flag.withDescription("The address clients reach this server at, e.g. https://mcp.example.com [env: P2M_PUBLIC_URL]"),
      Flag.withFallbackConfig(Config.String("P2M_PUBLIC_URL")),
      Flag.optional
    ),
    ...limits
  },
  Effect.fn(function*(flags) {
    const url = yield* requireDatabaseUrl(flags.databaseUrl)
    const username = Option.getOrElse(flags.adminUsername, () => "").trim()
    const password = Option.getOrElse(flags.adminPassword, () => "")
    // An empty value is the same as none: compose files pass unset variables through as "".
    const setupToken = Option.getOrElse(flags.setupToken, () => "").trim()
    const publicUrl = yield* parsePublicUrl(Option.getOrElse(flags.publicUrl, () => ""))
    const config = Layer.succeed(AppConfig, {
      databaseUrl: url,
      host: flags.host,
      port: flags.port,
      dataDir: flags.dataDir,
      bootstrapAdmin: username !== "" && password !== "" ? { username, password } : null,
      // Every HTTP deployment protects first-run setup, including localhost
      // servers that may sit behind a public reverse proxy.
      setupToken: setupToken || randomBytes(32).toString("base64url"),
      publicUrl,
      maxRows: flags.maxRows,
      maxBytes: DEFAULTS.maxBytes,
      queryTimeoutMs: flags.queryTimeoutMs,
      logRetentionDays: flags.logRetentionDays,
      poolSize: DEFAULTS.poolSize,
      webDir: findWebDir()
    })
    // Services are built once and shared by the routes and the banner.
    const services = ServicesLayer.pipe(Layer.provideMerge(config))
    return yield* Layer.launch(
      Layer.merge(HttpLayer, Banner).pipe(Layer.provide(services))
    )
  })
).pipe(
  Command.withDescription("Start the server: MCP endpoint, admin API and dashboard"),
  Command.withExamples([
    { command: "postgres2mcp serve -d postgres://localhost/app", description: "Expose a local database" },
    { command: "DATABASE_URL=postgres://… postgres2mcp serve --port 8080", description: "Configure from the environment" }
  ])
)

// ── stdio ────────────────────────────────────────────────────────────────────

const PARSE_ERROR: McpReply = {
  response: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
  notifications: []
}

export const stdio = Command.make(
  "stdio",
  {
    databaseUrl,
    dataDir,
    groups: Flag.String("groups").pipe(
      Flag.withDescription("Comma-separated tool groups to expose"),
      Flag.withDefault("schema,read,custom")
    ),
    tools: Flag.String("tools").pipe(
      Flag.withDescription("Comma-separated extra tools to expose"),
      Flag.withDefault("")
    ),
    format: Flag.Literals("format", ["compact", "objects", "markdown", "csv"]).pipe(
      Flag.withDescription("How rows are written in results (default: the server's saved setting)"),
      Flag.optional
    ),
    ...limits
  },
  Effect.fn(function*(flags) {
    const url = yield* requireDatabaseUrl(flags.databaseUrl)
    const config = Layer.succeed(AppConfig, {
      databaseUrl: url,
      host: DEFAULTS.host,
      port: DEFAULTS.port,
      dataDir: flags.dataDir,
      bootstrapAdmin: null,
      setupToken: null,
      publicUrl: null,
      maxRows: flags.maxRows,
      maxBytes: DEFAULTS.maxBytes,
      queryTimeoutMs: flags.queryTimeoutMs,
      logRetentionDays: flags.logRetentionDays,
      poolSize: DEFAULTS.poolSize,
      webDir: null
    })
    const caller: Caller = {
      source: "stdio",
      key_id: null,
      key_name: null,
      grants: { groups: list(flags.groups), tools: list(flags.tools) },
      client: "stdio",
      format: Option.getOrNull(flags.format)
    }

    const program = Effect.gen(function*() {
      const mcp = yield* Mcp
      const io = yield* Stdio.Stdio
      // Newline-delimited JSON-RPC in, newline-delimited JSON-RPC out.
      yield* io.stdin.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.trim() !== ""),
        Stream.mapEffect((line) =>
          Effect.try(() => JSON.parse(line) as unknown).pipe(
            Effect.flatMap((message) => mcp.handleBody(message, caller)),
            Effect.catch(() => Effect.succeed(PARSE_ERROR))
          )
        ),
        // The answer first, then anything the client should know besides.
        Stream.map((reply) =>
          [...(reply.response === null ? [] : [reply.response]), ...reply.notifications]
            .map((message) => `${JSON.stringify(message)}\n`)
            .join("")
        ),
        Stream.filter((text) => text !== ""),
        Stream.run(io.stdout({ endOnDone: false }))
      )
    })

    return yield* program.pipe(
      Effect.provide(ServicesLayer.pipe(Layer.provide(config))),
      // stdout carries the protocol; anything logged must go to stderr.
      Effect.provideService(Logger.LogToStderr, true)
    )
  })
).pipe(
  Command.withDescription("Speak MCP over stdin/stdout, for clients that launch the server themselves"),
  Command.withExamples([
    {
      command: "claude mcp add pg -- postgres2mcp stdio -d postgres://localhost/app",
      description: "Register with Claude Code as a local server"
    },
    { command: "postgres2mcp stdio --groups schema,read,custom,authoring", description: "Also let the client write custom tools" },
    { command: "postgres2mcp stdio --groups all", description: "Expose every tool, including writes and admin" }
  ])
)

// ── reset-password ───────────────────────────────────────────────────────────

/** Read a password twice from the terminal. */
const promptNewPassword = (message: string) =>
  Effect.gen(function*() {
    const first = Redacted.value(yield* Prompt.run(Prompt.Password({ message })))
    const second = Redacted.value(yield* Prompt.run(Prompt.Password({ message: "Repeat it" })))
    if (first !== second) return yield* new UsageError({ message: "The two passwords do not match." })
    return first
  })

// Locked out? This works on the state file directly, so it needs shell access
// to the machine (or container) the server runs on — which is the point.
export const resetPassword = Command.make(
  "reset-password",
  {
    username: Argument.String("username").pipe(Argument.withDescription("Account to reset (created if it does not exist)")),
    password: Flag.String("password").pipe(Flag.withDescription("The new password (prompted for when omitted)"), Flag.optional),
    dataDir
  },
  Effect.fn(function*(flags) {
    if (!existsSync(join(flags.dataDir, "postgres2mcp.db"))) {
      return yield* new UsageError({
        message: `No postgres2mcp state in ${resolve(flags.dataDir)}. Run this where the server keeps its data, or pass --data-dir.`
      })
    }
    const password = Option.isSome(flags.password)
      ? flags.password.value
      : yield* promptNewPassword(`New password for ${flags.username}`)
    const config = Layer.succeed(AppConfig, {
      databaseUrl: "postgres://unused",
      host: DEFAULTS.host,
      port: DEFAULTS.port,
      dataDir: flags.dataDir,
      bootstrapAdmin: null,
      setupToken: null,
      publicUrl: null,
      maxRows: DEFAULTS.maxRows,
      maxBytes: DEFAULTS.maxBytes,
      queryTimeoutMs: DEFAULTS.queryTimeoutMs,
      logRetentionDays: DEFAULTS.logRetentionDays,
      poolSize: DEFAULTS.poolSize,
      webDir: null
    })
    const user = yield* Effect.flatMap(Auth, (auth) => auth.resetPassword(flags.username, password)).pipe(
      Effect.provide(Auth.layer.pipe(Layer.provide(Store.layer), Layer.provide(config))),
      Effect.mapError((error) => new UsageError({ message: error.message }))
    )
    yield* Console.log(`Password set for ${user.username}. Its other sessions were signed out.`)
  })
).pipe(
  Command.withDescription("Set an admin password directly in the server's state (run on the server's machine)"),
  Command.withExamples([
    { command: "postgres2mcp reset-password admin", description: "Prompt for a new password" },
    { command: "docker exec -it postgres2mcp bun src/bin.ts reset-password admin", description: "Inside the container" }
  ])
)

export const commands = Command.make("postgres2mcp").pipe(
  Command.withDescription("Turn a Postgres database into an MCP server"),
  Command.withSubcommands([serve, stdio, resetPassword])
)
