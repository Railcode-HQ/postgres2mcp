import { Effect, Fiber, Layer, Option, Redacted } from "effect"
import type { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import type { ApiKey, SchemaTable, ToolGroup } from "../domain.ts"
import { GROUP_ID_RE, TOOL_NAME_RE } from "../domain.ts"
import { BadRequest, NotFound } from "../errors.ts"
import { AppConfig } from "../services/AppConfig.ts"
import { Auth } from "../services/Auth.ts"
import { Pg } from "../services/Pg.ts"
import { type KeyRow, Store } from "../services/Store.ts"
import { type Caller, type Catalog, isBuiltinGroup, Tools } from "../services/Tools.ts"
import { deriveParams } from "../sql/template.ts"
import { VERSION } from "../version.ts"
import { AdminAuth, Api, CurrentSession } from "./Api.ts"

// ── auth ─────────────────────────────────────────────────────────────────────

export const AdminAuthLayer = Layer.effect(
  AdminAuth,
  Effect.gen(function*() {
    const auth = yield* Auth
    return AdminAuth.of({
      bearer: Effect.fn(function*(httpEffect, { credential }) {
        const token = Redacted.value(credential)
        const session = yield* auth.authenticate(token)
        return yield* Effect.provideService(httpEffect, CurrentSession, { token, ...session })
      })
    })
  })
)

const clientOf = (request: HttpServerRequest.HttpServerRequest) => request.headers["user-agent"] ?? null

/** A signed-in admin is unrestricted. */
const adminCaller = (request: HttpServerRequest.HttpServerRequest): Caller => ({
  source: "admin",
  key_id: null,
  key_name: null,
  grants: null,
  client: clientOf(request),
  format: null
})

// ── shared checks ────────────────────────────────────────────────────────────

const presentKey = (row: KeyRow, catalog: Catalog, tools: Tools["Service"]): ApiKey => ({
  ...row,
  effective_tools: tools.resolve(row, catalog)
})

/** Every group id and tool name a key or group refers to must exist. */
const checkGrants = (
  catalog: Catalog,
  grants: { readonly groups?: ReadonlyArray<string> | undefined; readonly tools?: ReadonlyArray<string> | undefined }
): Effect.Effect<void, BadRequest> => {
  const groupIds = new Set(catalog.groups.map((group) => group.id))
  const toolNames = new Set(catalog.tools.map((tool) => tool.name))
  const unknownGroup = grants.groups?.find((id) => !groupIds.has(id))
  if (unknownGroup !== undefined) return Effect.fail(new BadRequest({ message: `Unknown group "${unknownGroup}"` }))
  const unknownTool = grants.tools?.find((name) => !toolNames.has(name))
  if (unknownTool !== undefined) return Effect.fail(new BadRequest({ message: `Unknown tool "${unknownTool}"` }))
  return Effect.void
}

const unique = (values: ReadonlyArray<string>) => [...new Set(values)]

const SCHEMA_SNAPSHOT = `SELECT coalesce(json_agg(t ORDER BY t.schema, t.name), '[]'::json)
FROM (
  SELECT n.nspname AS schema,
         c.relname AS name,
         CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table' ELSE 'table' END AS type,
         (SELECT coalesce(json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod)) ORDER BY a.attnum), '[]'::json)
            FROM pg_attribute a
           WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND NOT c.relispartition
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
  ORDER BY 1, 2
  LIMIT 500
) t`

// ── handlers ─────────────────────────────────────────────────────────────────

const AuthHandlers = HttpApiBuilder.group(
  Api,
  "auth",
  Effect.fn(function*(handlers) {
    const auth = yield* Auth
    return handlers.handleAll({
      state: () =>
        Effect.map(auth.setupRequired, (setup_required) => ({
          setup_required,
          setup_code_required: setup_required && auth.setupCodeRequired,
          version: VERSION
        })),
      setup: ({ payload, request }) =>
        auth.setup(payload.username, payload.password, clientOf(request), payload.setup_code),
      login: ({ payload, request }) => auth.login(payload.username, payload.password, clientOf(request)),
      me: () => Effect.map(CurrentSession, (session) => ({ username: session.username })),
      logout: () => Effect.flatMap(CurrentSession, (session) => auth.logout(session.token)),
      password: ({ payload }) =>
        Effect.flatMap(CurrentSession, (session) =>
          auth.changePassword(session, session.token, payload.current_password, payload.new_password))
    })
  })
)

const SettingsHandlers = HttpApiBuilder.group(
  Api,
  "settings",
  Effect.fn(function*(handlers) {
    const store = yield* Store
    return handlers.handleAll({
      get: () => store.getSettings,
      update: ({ payload }) =>
        store.updateSettings(payload.result_format === undefined ? {} : { result_format: payload.result_format })
    })
  })
)

const SystemHandlers = HttpApiBuilder.group(
  Api,
  "system",
  Effect.fn(function*(handlers) {
    const config = yield* AppConfig
    const pg = yield* Pg
    const store = yield* Store
    const tools = yield* Tools

    // Anyone can ask for /health, so the database is asked at most once every
    // few seconds, and a database that is slow to refuse does not hold the
    // answer up: the question carries on in the background and health says
    // "not answering" in the meantime.
    const askDatabase = yield* Effect.cachedWithTTL(
      pg.info.pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false))),
      "5 seconds"
    )
    const databaseAnswers = Effect.forkDetach(askDatabase).pipe(
      Effect.flatMap((fiber) => Fiber.join(fiber).pipe(Effect.timeoutOption("3 seconds"))),
      Effect.map(Option.getOrElse(() => false))
    )

    return handlers.handleAll({
      health: () => Effect.map(databaseAnswers, (database) => ({ ok: true, version: VERSION, database })),
      status: Effect.fn(function*() {
        const database = yield* pg.info.pipe(
          Effect.map((info) => ({
            connected: true,
            name: info.name,
            user: info.user,
            host: info.host,
            server_version: info.server_version,
            error: null
          })),
          Effect.catch((error) =>
            Effect.succeed({
              connected: false,
              name: null,
              user: null,
              host: null,
              server_version: null,
              error: error.message
            })
          )
        )
        const catalog = yield* tools.catalog
        return {
          version: VERSION,
          public_url: config.publicUrl,
          database,
          limits: {
            max_rows: config.maxRows,
            query_timeout_ms: config.queryTimeoutMs,
            log_retention_days: config.logRetentionDays
          },
          counts: {
            tools: catalog.tools.length,
            custom_tools: catalog.tools.filter((tool) => tool.kind === "custom").length,
            keys: (yield* store.listKeys).length,
            groups: catalog.groups.length
          }
        }
      }),
      schema: () =>
        pg.run(SCHEMA_SNAPSHOT, [], { readOnly: true }).pipe(
          Effect.map((result) => ({ tables: (result.rows[0]?.[0] ?? []) as Array<SchemaTable> }))
        ),
      stats: ({ query }) => store.stats(query.range ?? "24h")
    })
  })
)

const ToolsHandlers = HttpApiBuilder.group(
  Api,
  "tools",
  Effect.fn(function*(handlers) {
    const tools = yield* Tools

    return handlers.handleAll({
      list: () => tools.catalog,
      call: Effect.fn(function*({ params, payload, request }) {
        const started = performance.now()
        const outcome = yield* tools.call(params.name, payload.arguments ?? {}, adminCaller(request)).pipe(
          Effect.catchTags({
            ToolNotFound: (error) => Effect.fail(new NotFound({ message: error.message })),
            // An admin is never denied; keep the type honest all the same.
            ToolDenied: (error) => Effect.fail(new BadRequest({ message: error.message }))
          })
        )
        return { data: outcome.data, duration_ms: Math.round((performance.now() - started) * 100) / 100 }
      })
    })
  })
)

const GroupsHandlers = HttpApiBuilder.group(
  Api,
  "groups",
  Effect.fn(function*(handlers) {
    const store = yield* Store
    const tools = yield* Tools

    const present = (id: string) =>
      Effect.flatMap(tools.catalog, (catalog): Effect.Effect<ToolGroup, NotFound> => {
        const group = catalog.groups.find((candidate) => candidate.id === id)
        return group ? Effect.succeed(group) : Effect.fail(new NotFound({ message: `No group "${id}"` }))
      })

    return handlers.handleAll({
      list: () => Effect.map(tools.catalog, (catalog) => catalog.groups),
      create: Effect.fn(function*({ payload }) {
        if (!GROUP_ID_RE.test(payload.id)) {
          return yield* new BadRequest({
            message: "Group id must start with a letter and use lowercase letters, digits, - or _ (max 64)"
          })
        }
        const catalog = yield* tools.catalog
        if (catalog.groups.some((group) => group.id === payload.id)) {
          return yield* new BadRequest({ message: `A group "${payload.id}" already exists` })
        }
        yield* checkGrants(catalog, { tools: payload.tools })
        yield* store.createGroup({
          id: payload.id,
          name: payload.name?.trim() || payload.id,
          description: payload.description?.trim() ?? "",
          tools: unique(payload.tools)
        })
        return yield* Effect.orDie(present(payload.id))
      }),
      update: Effect.fn(function*({ params, payload }) {
        if (isBuiltinGroup(params.id)) {
          return yield* new BadRequest({ message: `"${params.id}" is a built-in group and cannot be changed` })
        }
        if (payload.tools !== undefined) yield* checkGrants(yield* tools.catalog, { tools: payload.tools })
        const updated = yield* store.updateGroup(params.id, {
          name: payload.name?.trim() || undefined,
          description: payload.description?.trim(),
          tools: payload.tools === undefined ? undefined : unique(payload.tools)
        })
        if (updated === null) return yield* new NotFound({ message: `No group "${params.id}"` })
        return yield* present(params.id)
      }),
      remove: Effect.fn(function*({ params }) {
        if (isBuiltinGroup(params.id)) {
          return yield* new BadRequest({ message: `"${params.id}" is a built-in group and cannot be deleted` })
        }
        if (!(yield* store.deleteGroup(params.id))) {
          return yield* new NotFound({ message: `No group "${params.id}"` })
        }
        // Keys must not keep a grant to a group that is gone: a group created
        // later under the same id would silently inherit it.
        for (const key of yield* store.listKeys) {
          if (key.groups.includes(params.id)) {
            yield* store.updateKey(key.id, { groups: key.groups.filter((id) => id !== params.id) })
          }
        }
      })
    })
  })
)

const KeysHandlers = HttpApiBuilder.group(
  Api,
  "keys",
  Effect.fn(function*(handlers) {
    const store = yield* Store
    const tools = yield* Tools

    return handlers.handleAll({
      list: Effect.fn(function*() {
        const catalog = yield* tools.catalog
        return (yield* store.listKeys).map((row) => presentKey(row, catalog, tools))
      }),
      create: Effect.fn(function*({ payload }) {
        const name = payload.name.trim()
        if (name === "") return yield* new BadRequest({ message: "A key needs a name" })
        const catalog = yield* tools.catalog
        yield* checkGrants(catalog, payload)
        const { key, token } = yield* store.createKey({
          name,
          groups: unique(payload.groups ?? []),
          tools: unique(payload.tools ?? []),
          result_format: payload.result_format ?? null
        })
        return { key: presentKey(key, catalog, tools), token }
      }),
      update: Effect.fn(function*({ params, payload }) {
        const catalog = yield* tools.catalog
        yield* checkGrants(catalog, payload)
        if (payload.name !== undefined && payload.name.trim() === "") {
          return yield* new BadRequest({ message: "A key needs a name" })
        }
        const updated = yield* store.updateKey(params.id, {
          name: payload.name?.trim(),
          groups: payload.groups === undefined ? undefined : unique(payload.groups),
          tools: payload.tools === undefined ? undefined : unique(payload.tools),
          enabled: payload.enabled,
          result_format: payload.result_format
        })
        if (updated === null) return yield* new NotFound({ message: `No API key "${params.id}"` })
        return presentKey(updated, catalog, tools)
      }),
      remove: Effect.fn(function*({ params }) {
        if (!(yield* store.deleteKey(params.id))) {
          return yield* new NotFound({ message: `No API key "${params.id}"` })
        }
      })
    })
  })
)

const CustomToolsHandlers = HttpApiBuilder.group(
  Api,
  "customTools",
  Effect.fn(function*(handlers) {
    const tools = yield* Tools

    return handlers.handleAll({
      list: () => tools.custom.list,
      get: ({ params }) => tools.custom.get(params.name),
      create: ({ payload }) => tools.custom.create(payload),
      update: ({ params, payload }) => tools.custom.update(params.name, payload),
      remove: ({ params }) => tools.custom.remove(params.name),
      run: Effect.fn(function*({ params, payload, request }) {
        const tool = yield* tools.custom.get(params.name)
        return yield* tools.testDraft({
          name: tool.name,
          version: tool.version,
          sql: tool.sql,
          params: tool.params,
          values: payload.params ?? {},
          allow_writes: tool.allow_writes
        }, adminCaller(request))
      }),
      test: ({ payload, request }) =>
        tools.testDraft({
          name: payload.name !== undefined && TOOL_NAME_RE.test(payload.name) ? payload.name : null,
          sql: payload.sql,
          params: payload.params ?? deriveParams(payload.sql),
          values: payload.values ?? {},
          allow_writes: payload.allow_writes ?? false
        }, adminCaller(request))
    })
  })
)

const SqlHandlers = HttpApiBuilder.group(
  Api,
  "sql",
  Effect.fn(function*(handlers) {
    const tools = yield* Tools
    return handlers.handleAll({
      run: ({ payload, request }) =>
        tools.runSql({
          sql: payload.sql,
          params: payload.params ?? [],
          allow_writes: payload.allow_writes ?? false
        }, adminCaller(request))
    })
  })
)

const LogsHandlers = HttpApiBuilder.group(
  Api,
  "logs",
  Effect.fn(function*(handlers) {
    const store = yield* Store
    return handlers.handleAll({
      list: Effect.fn(function*({ query }) {
        const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), 500)
        // One extra row tells us whether another page exists.
        const rows = yield* store.listLogs({ ...query, limit: limit + 1 })
        const logs = rows.slice(0, limit)
        return {
          logs,
          next_before: rows.length > limit && logs.length > 0 ? logs[logs.length - 1]!.id : null
        }
      }),
      get: Effect.fn(function*({ params }) {
        const entry = yield* store.getLog(params.id)
        if (entry === null) return yield* new NotFound({ message: `No log entry ${params.id}` })
        return entry
      }),
      clear: () => Effect.map(store.clearLogs, (deleted) => ({ deleted }))
    })
  })
)

export const ApiHandlers = Layer.mergeAll(
  AuthHandlers,
  SystemHandlers,
  SettingsHandlers,
  ToolsHandlers,
  CustomToolsHandlers,
  GroupsHandlers,
  KeysHandlers,
  SqlHandlers,
  LogsHandlers
)
