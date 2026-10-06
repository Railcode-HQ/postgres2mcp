// The tool registry: built-in tools plus the custom tools written on this
// server, the groups they belong to, who may call what, and the single `call`
// path that enforces it and writes the log. MCP and the admin API both end up
// here.
import { Context, Effect, Layer, Schema } from "effect"
import type { LogEntry, LogSource, QueryResult, ResultFormat, ToolGroup, ToolInfo, ToolParam } from "../domain.ts"
import { BadRequest, type QueryError } from "../errors.ts"
import { hasMultipleStatements, isBlank } from "../sql/sqltext.ts"
import { compileTemplate, paramsJsonSchema, validateTemplate } from "../sql/template.ts"
import { makeAuthoringTools } from "../tools/authoring.ts"
import {
  BUILTIN_GROUPS,
  type BuiltinTool,
  isBuiltinGroup,
  makeBuiltins,
  tabular,
  type ToolContext,
  type ToolOutcome
} from "../tools/builtin.ts"
import { type CustomToolAdmin, makeCustomToolAdmin } from "../tools/customTools.ts"
import { Pg } from "./Pg.ts"
import { type CustomToolRow, Store } from "./Store.ts"

export class ToolNotFound extends Schema.TaggedError<ToolNotFound>()("ToolNotFound", {
  name: Schema.String
}) {
  override get message() {
    return `Unknown tool: ${this.name}`
  }
}

export class ToolDenied extends Schema.TaggedError<ToolDenied>()("ToolDenied", {
  name: Schema.String
}) {
  override get message() {
    return `This API key is not allowed to call ${this.name}`
  }
}

/** What a caller may use: group ids plus individually named tools. */
export interface Grants {
  readonly groups: ReadonlyArray<string>
  readonly tools: ReadonlyArray<string>
}

/** Who is calling. `grants: null` means unrestricted (an admin). */
export interface Caller {
  readonly source: LogSource
  readonly key_id: string | null
  readonly key_name: string | null
  readonly grants: Grants | null
  readonly client: string | null
  /** How this caller wants rows written; null follows the server default. */
  readonly format: ResultFormat | null
}

export interface Catalog {
  readonly tools: Array<ToolInfo>
  readonly groups: Array<ToolGroup>
}

export class Tools extends Context.Service<Tools, {
  /** Every tool and group on the server, resolved against the current custom tools. */
  readonly catalog: Effect.Effect<Catalog>
  /** The tools a caller is allowed to see and call. */
  visibleTo(caller: Caller): Effect.Effect<Array<ToolInfo>>
  /** Resolve grants to concrete tool names. */
  resolve(grants: Grants, catalog: Catalog): Array<string>
  /** Create, change and delete custom tools — the one place that validates them. */
  readonly custom: CustomToolAdmin
  call(
    name: string,
    args: Record<string, unknown>,
    caller: Caller
  ): Effect.Effect<ToolOutcome, ToolNotFound | ToolDenied | BadRequest | QueryError>
  /** Arbitrary SQL from the dashboard's console. Logged as `sql`. */
  runSql(
    input: { readonly sql: string; readonly params: ReadonlyArray<unknown>; readonly allow_writes: boolean },
    caller: Caller
  ): Effect.Effect<QueryResult, BadRequest | QueryError>
  /** Run a custom-tool template that may not be stored yet (the editor's Run): same validate + compile + execute path as a real call. */
  testDraft(
    input: {
      readonly name: string | null
      /** Set when running a stored tool as-is; drafts leave it out. */
      readonly version?: number | undefined
      readonly sql: string
      readonly params: ReadonlyArray<ToolParam>
      readonly values: Record<string, unknown>
      readonly allow_writes: boolean
    },
    caller: Caller
  ): Effect.Effect<QueryResult, BadRequest | QueryError>
}>()("postgres2mcp/Tools") {
  static readonly layer = Layer.effect(
    Tools,
    Effect.gen(function*() {
      const pg = yield* Pg
      const store = yield* Store

      /** A custom-tool template, checked and compiled the way a real call would be. `sql` is null when it does not compile. */
      const draftPlan = (input: {
        readonly label: string
        readonly sql: string
        readonly params: ReadonlyArray<ToolParam>
        readonly values: Record<string, unknown>
        readonly allow_writes: boolean
      }): { readonly sql: string | null; readonly run: Effect.Effect<QueryResult, BadRequest | QueryError> } => {
        const invalid = validateTemplate(input.sql, input.params)
        if (invalid !== null) return { sql: null, run: Effect.fail(new BadRequest({ message: invalid })) }
        const compiled = compileTemplate(input.sql, input.params, input.values)
        if (!compiled.ok) return { sql: null, run: Effect.fail(new BadRequest({ message: compiled.error })) }
        const sql = `/* custom_tool:${input.label} */\n${compiled.sql}`
        return { sql, run: pg.run(sql, compiled.values, { readOnly: !input.allow_writes }) }
      }

      // A custom tool may not take a built-in's name, nor the log's name for console SQL.
      const custom = makeCustomToolAdmin(store, (name) => builtinByName.has(name) || name === "sql")
      const builtins = [
        ...makeBuiltins(pg),
        ...makeAuthoringTools({
          custom,
          draft: (input) => draftPlan({ ...input, label: "unsaved@draft", allow_writes: false })
        })
      ]
      const builtinByName = new Map(builtins.map((tool) => [tool.name, tool]))

      const buildCatalog = (customTools: ReadonlyArray<CustomToolRow>, custom: ReadonlyArray<ToolGroup>): Catalog => {
        const customNames = customTools.map((tool) => tool.name)
        const exists = new Set([...builtinByName.keys(), ...customNames])

        const groups: Array<ToolGroup> = [
          ...BUILTIN_GROUPS.map((group): ToolGroup => ({
            ...group,
            builtin: true,
            tools: group.id === "all"
              ? [...exists]
              : group.id === "custom"
              ? customNames
              : builtins.filter((tool) => tool.group === group.id).map((tool) => tool.name)
          })),
          // A custom group only ever resolves to tools that exist right now.
          ...custom.map((group) => ({ ...group, tools: group.tools.filter((name) => exists.has(name)) }))
        ]

        const groupsOf = (name: string) =>
          groups.filter((group) => group.tools.includes(name)).map((group) => group.id)

        const tools: Array<ToolInfo> = [
          ...builtins.map((tool): ToolInfo => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            kind: "builtin",
            access: tool.access,
            destructive: tool.destructive,
            groups: groupsOf(tool.name),
            input_schema: tool.inputSchema
          })),
          ...customTools.map((tool): ToolInfo => ({
            name: tool.name,
            title: tool.name,
            description: tool.description || `Custom tool ${tool.name}`,
            kind: "custom",
            access: tool.allow_writes ? "write" : "read",
            // What a write tool does is the author's business; assume the worst for the hint.
            destructive: tool.allow_writes,
            groups: groupsOf(tool.name),
            input_schema: paramsJsonSchema(tool.params)
          }))
        ]
        return { tools, groups }
      }

      const catalog = Effect.gen(function*() {
        const customTools = yield* store.listCustomTools
        const custom = yield* store.listGroups
        return buildCatalog(customTools, custom.map((group) => ({ ...group, builtin: false })))
      })

      const resolve = (grants: Grants, catalog: Catalog): Array<string> => {
        const exists = new Set(catalog.tools.map((tool) => tool.name))
        const allowed = new Set<string>()
        for (const id of grants.groups) {
          for (const name of catalog.groups.find((group) => group.id === id)?.tools ?? []) allowed.add(name)
        }
        for (const name of grants.tools) {
          if (exists.has(name)) allowed.add(name)
        }
        // Catalog order, so a key's tool list reads the same everywhere.
        return catalog.tools.map((tool) => tool.name).filter((name) => allowed.has(name))
      }

      const visibleTo = (caller: Caller) =>
        Effect.map(catalog, (current) => {
          if (caller.grants === null) return current.tools
          const allowed = new Set(resolve(caller.grants, current))
          return current.tools.filter((tool) => allowed.has(tool.name))
        })

      const record = (
        caller: Caller,
        entry: Pick<LogEntry, "tool" | "kind" | "status" | "row_count" | "error" | "sql"> & {
          readonly args: unknown
          readonly started: number
        }
      ) =>
        store.insertLog({
          source: caller.source,
          key_id: caller.key_id,
          key_name: caller.key_name,
          client: caller.client,
          tool: entry.tool,
          kind: entry.kind,
          status: entry.status,
          duration_ms: Math.round((performance.now() - entry.started) * 100) / 100,
          row_count: entry.row_count,
          error: entry.error,
          args: entry.args === undefined ? null : JSON.stringify(entry.args),
          sql: entry.sql
        })

      /** Run an effect and write exactly one log row for how it ended. */
      const logged = <A extends { readonly row_count: number | null }, E extends { readonly message: string }>(
        caller: Caller,
        meta: {
          readonly tool: string
          readonly kind: LogEntry["kind"]
          readonly args: unknown
          readonly sql: string | null
          readonly started: number
        },
        effect: Effect.Effect<A, E>,
        sqlOf: (result: A) => string | null = () => meta.sql
      ) =>
        effect.pipe(
          Effect.tap((result) =>
            record(caller, { ...meta, status: "ok", row_count: result.row_count, error: null, sql: sqlOf(result) })
          ),
          Effect.tapError((error) =>
            record(caller, { ...meta, status: "error", row_count: null, error: error.message })
          )
        )

      const customToolPlan = (tool: CustomToolRow, args: Record<string, unknown>) => {
        const compiled = compileTemplate(tool.sql, tool.params, args)
        if (!compiled.ok) {
          return { sql: null, run: Effect.fail(new BadRequest({ message: compiled.error })) }
        }
        // The prefix makes the tool recognisable in pg_stat_activity and server logs.
        const sql = `/* custom_tool:${tool.name} v${tool.version} */\n${compiled.sql}`
        return {
          sql,
          run: pg.run(sql, compiled.values, { readOnly: !tool.allow_writes }).pipe(
            Effect.map((result): ToolOutcome => ({
              data: tabular(result),
              rows: result,
              sql,
              row_count: result.row_count
            }))
          )
        }
      }

      const call = Effect.fn("Tools.call")(function*(name: string, rawArgs: Record<string, unknown>, caller: Caller) {
        const started = performance.now()
        const builtin = builtinByName.get(name)
        const stored = builtin ? null : yield* store.getCustomTool(name)
        const kind: LogEntry["kind"] = builtin ? "builtin" : stored ? "custom" : "unknown"

        if (!builtin && !stored) {
          yield* record(caller, {
            tool: name,
            kind,
            status: "error",
            row_count: null,
            error: "Unknown tool",
            sql: null,
            args: rawArgs,
            started
          })
          return yield* new ToolNotFound({ name })
        }

        const { grants } = caller
        if (grants !== null) {
          const allowed = resolve(grants, yield* catalog)
          if (!allowed.includes(name)) {
            yield* record(caller, {
              tool: name,
              kind,
              status: "denied",
              row_count: null,
              error: "Not allowed for this API key",
              sql: null,
              args: rawArgs,
              started
            })
            return yield* new ToolDenied({ name })
          }
        }

        // Models routinely send `null` for an argument they mean to omit.
        const args = Object.fromEntries(Object.entries(rawArgs).filter(([, value]) => value !== null))
        // Asked at the moment of use: a tool may have just been created by this very call.
        const context: ToolContext = {
          holds: (tool) =>
            grants === null
              ? Effect.succeed(true)
              : Effect.map(catalog, (current) => resolve(grants, current).includes(tool))
        }
        const plan = builtin
          ? { sql: typeof args.sql === "string" ? args.sql : null, run: builtin.run(args, context) }
          : customToolPlan(stored!, args)

        return yield* logged(
          caller,
          { tool: name, kind, args: rawArgs, sql: plan.sql, started },
          plan.run,
          (outcome) => outcome.sql
        )
      })

      const runSql = Effect.fn("Tools.runSql")(function*(
        input: { readonly sql: string; readonly params: ReadonlyArray<unknown>; readonly allow_writes: boolean },
        caller: Caller
      ) {
        const started = performance.now()
        const check: Effect.Effect<void, BadRequest> = isBlank(input.sql)
          ? Effect.fail(new BadRequest({ message: "SQL is required" }))
          : hasMultipleStatements(input.sql)
          ? Effect.fail(new BadRequest({ message: "Only a single SQL statement is allowed per call" }))
          : Effect.void
        return yield* logged(
          caller,
          {
            tool: "sql",
            kind: "sql",
            args: { params: input.params, allow_writes: input.allow_writes },
            sql: input.sql,
            started
          },
          Effect.andThen(check, pg.run(input.sql, input.params, { readOnly: !input.allow_writes }))
        )
      })

      const testDraft = Effect.fn("Tools.testDraft")(function*(
        input: {
          readonly name: string | null
          readonly version?: number | undefined
          readonly sql: string
          readonly params: ReadonlyArray<ToolParam>
          readonly values: Record<string, unknown>
          readonly allow_writes: boolean
        },
        caller: Caller
      ) {
        const started = performance.now()
        const label = input.name !== null && input.version !== undefined
          ? `${input.name} v${input.version}`
          : `${input.name ?? "unsaved"}@draft${input.allow_writes ? "+writes" : ""}`
        const plan = draftPlan({ ...input, label })
        return yield* logged(
          caller,
          { tool: input.name ?? "draft", kind: "custom", args: input.values, sql: plan.sql, started },
          plan.run
        )
      })

      return Tools.of({ catalog, visibleTo, resolve, custom, call, runSql, testDraft })
    })
  )
}

export { isBuiltinGroup }
export type { BuiltinTool, ToolOutcome }
