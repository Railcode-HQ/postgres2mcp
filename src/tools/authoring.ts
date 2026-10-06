// The tools that let an MCP client write custom tools itself. Unlike the other
// built-ins they act on postgres2mcp's own state rather than the database —
// except `test_custom_tool`, which runs a draft, read-only.
//
// Who may call a tool stays with the admin: these tools never touch keys or
// groups. And a caller cannot mint more than it holds — a tool that writes can
// only be authored by a caller that could already write with `execute_sql`.
import { Effect, Schema } from "effect"
import { type CustomTool, ParamType, type QueryResult, type ToolParam } from "../domain.ts"
import { BadRequest, type NotFound, type QueryError } from "../errors.ts"
import { deriveParams } from "../sql/template.ts"
import { type BuiltinTool, define, tabular, type ToolContext, type ToolOutcome } from "./builtin.ts"
import type { CustomToolAdmin } from "./customTools.ts"

/** The built-in tool whose holders may author tools that write. */
const WRITE_TOOL = "execute_sql"

/** Calling one of these changes what `tools/list` returns. */
export const TOOL_LIST_CHANGERS: ReadonlySet<string> = new Set([
  "create_custom_tool",
  "update_custom_tool",
  "delete_custom_tool"
])

export interface AuthoringDeps {
  readonly custom: CustomToolAdmin
  /** Validate, compile and run a draft in a read-only transaction. `sql` is null when it does not compile. */
  readonly draft: (input: {
    readonly sql: string
    readonly params: ReadonlyArray<ToolParam>
    readonly values: Record<string, unknown>
  }) => { readonly sql: string | null; readonly run: Effect.Effect<QueryResult, BadRequest | QueryError> }
}

// ── argument schemas ─────────────────────────────────────────────────────────

const ToolName = Schema.String.annotate({
  description: "The tool's name: lowercase letters, digits and underscores, starting with a letter."
})

const Template = Schema.String.annotate({
  description:
    "One SQL statement. Write :name where a caller supplies a value, e.g. WHERE status = :status LIMIT :limit. " +
    "Values are bound as parameters, so add a cast where Postgres cannot infer the type (:day::date)."
})

const Param = Schema.Struct({
  name: Schema.String.annotate({ description: "The placeholder's name, without the colon." }),
  type: ParamType.annotate({ description: "The caller's value must be exactly this type; nothing is coerced." }),
  default: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]).annotate({
    description: "Makes the argument optional: this is bound when the caller leaves it out."
  })),
  description: Schema.optionalKey(Schema.String.annotate({
    description: "What the value means. The model calling the tool reads this."
  }))
})

const Params = Schema.optionalKey(Schema.Array(Param).annotate({
  description: "One entry per :name placeholder. Leave out to make every placeholder a required string."
}))

const Description = Schema.optionalKey(Schema.String.annotate({
  description: "What the tool answers and when to use it. The model calling the tool reads this."
}))

// ── helpers ──────────────────────────────────────────────────────────────────

const requireWrite = (context: ToolContext): Effect.Effect<void, BadRequest> =>
  Effect.flatMap(context.holds(WRITE_TOOL), (held) =>
    held ? Effect.void : Effect.fail(
      new BadRequest({
        message:
          `A tool that writes can only be authored by a caller that holds ${WRITE_TOOL}, and you do not. ` +
          "Keep allow_writes off, or ask an admin."
      })
    ))

/** Over MCP a missing tool is something for the model to read and recover from. */
const inBand = <A>(effect: Effect.Effect<A, NotFound | BadRequest>): Effect.Effect<A, BadRequest> =>
  Effect.mapError(effect, (error) =>
    error._tag === "NotFound"
      ? new BadRequest({ message: `${error.message}. Use list_custom_tools to see what exists.` })
      : error)

const describe = (tool: CustomTool) => ({
  name: tool.name,
  description: tool.description,
  sql: tool.sql,
  params: tool.params,
  allow_writes: tool.allow_writes,
  version: tool.version,
  groups: tool.groups
})

/** The saved tool, plus whether the caller itself can use it. */
const saved = (tool: CustomTool, context: ToolContext): Effect.Effect<ToolOutcome> =>
  Effect.map(context.holds(tool.name), (callable): ToolOutcome => ({
    data: {
      ...describe(tool),
      note: callable
        ? `Saved as version ${tool.version}. List tools again to see it, then call it by name.`
        : `Saved as version ${tool.version}, but you cannot call it: your access does not include this tool or the "custom" group. An admin can grant it.`
    },
    sql: tool.sql,
    row_count: null,
    toolsChanged: true
  }))

// ── the tools ────────────────────────────────────────────────────────────────

export function makeAuthoringTools({ custom, draft }: AuthoringDeps): Array<BuiltinTool> {
  return [
    define({
      name: "list_custom_tools",
      title: "List custom tools",
      description:
        "Show the custom tools saved on this server with their SQL, params and version — including ones you cannot call. Pass a name for just that one.",
      group: "authoring",
      access: "read",
      input: Schema.Struct({
        name: Schema.optionalKey(Schema.String.annotate({ description: "Only this tool." }))
      }),
      handler: ({ name }) =>
        name === undefined
          ? Effect.map(custom.list, (tools): ToolOutcome => ({
            data: { tools: tools.map(describe) },
            sql: null,
            row_count: tools.length
          }))
          : inBand(custom.get(name)).pipe(
            Effect.map((tool): ToolOutcome => ({ data: describe(tool), sql: null, row_count: 1 }))
          )
    }),
    define({
      name: "test_custom_tool",
      title: "Test a custom tool draft",
      description:
        "Run a draft of a custom tool without saving it: the SQL template, its params and the values to try. Always runs read-only. Use it to get the SQL right before create_custom_tool or update_custom_tool.",
      group: "authoring",
      access: "read",
      input: Schema.Struct({
        sql: Template,
        params: Params,
        args: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown).annotate({
          description: "A value for each param, by name — what a caller of the finished tool would send."
        }))
      }),
      handler: ({ args, params, sql }) => {
        const plan = draft({ sql, params: params ?? deriveParams(sql), values: args ?? {} })
        return plan.run.pipe(
          Effect.map((result): ToolOutcome => ({
            data: tabular(result),
            rows: result,
            sql: plan.sql,
            row_count: result.row_count
          }))
        )
      }
    }),
    define({
      name: "create_custom_tool",
      title: "Create a custom tool",
      description:
        "Save a SQL statement as a new tool on this server, for a question worth asking again. Each :name placeholder becomes a typed argument of the tool. It runs read-only unless allow_writes is true. Test the SQL with test_custom_tool first.",
      group: "authoring",
      access: "admin",
      destructive: false,
      input: Schema.Struct({
        name: ToolName,
        sql: Template,
        description: Description,
        params: Params,
        allow_writes: Schema.optionalKey(Schema.Boolean.annotate({
          description: `Let the tool change data. Defaults to false. Needs a caller that holds ${WRITE_TOOL}.`
        }))
      }),
      handler: (input, context) =>
        Effect.gen(function*() {
          if (input.allow_writes === true) yield* requireWrite(context)
          return yield* saved(yield* custom.create(input), context)
        })
    }),
    define({
      name: "update_custom_tool",
      title: "Update a custom tool",
      description:
        "Change a saved custom tool: its SQL, params, description or whether it may write. Only what you pass changes. New SQL or params take effect at once for every caller of the tool and bump its version.",
      group: "authoring",
      access: "admin",
      input: Schema.Struct({
        name: ToolName,
        sql: Schema.optionalKey(Template),
        description: Description,
        params: Params,
        allow_writes: Schema.optionalKey(Schema.Boolean.annotate({
          description: `Whether the tool may change data. Turning it on needs a caller that holds ${WRITE_TOOL}.`
        }))
      }),
      handler: ({ name, ...patch }, context) =>
        Effect.gen(function*() {
          const current = yield* inBand(custom.get(name))
          // Editing a tool that writes is authoring one, whichever field changes.
          if (patch.allow_writes ?? current.allow_writes) yield* requireWrite(context)
          return yield* saved(yield* inBand(custom.update(name, patch)), context)
        })
    }),
    define({
      name: "delete_custom_tool",
      title: "Delete a custom tool",
      description:
        "Remove a saved custom tool from this server, for every caller. API keys and groups that named it lose it. Cannot be undone.",
      group: "authoring",
      access: "admin",
      input: Schema.Struct({ name: ToolName }),
      handler: ({ name }) =>
        inBand(custom.remove(name)).pipe(
          Effect.map((): ToolOutcome => ({
            data: { ok: true, deleted: name },
            sql: null,
            row_count: null,
            toolsChanged: true
          }))
        )
    })
  ]
}
