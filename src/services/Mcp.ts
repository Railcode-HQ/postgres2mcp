// The Model Context Protocol, tools only, stateless.
//
// Effect ships an McpServer, but it keeps one server-wide tool registry. Here
// the tool list is a function of the caller — each API key sees its own subset,
// and custom tools appear and disappear at runtime — so the (small) JSON-RPC
// surface is handled directly: initialize, ping, tools/list, tools/call.
//
// The one thing sent unasked is `notifications/tools/list_changed`, to a
// client whose own call just added, changed or removed a tool.
import { Context, Effect, Layer, Predicate } from "effect"
import type { ToolInfo } from "../domain.ts"
import { VERSION } from "../version.ts"
import { TOOL_LIST_CHANGERS } from "../tools/authoring.ts"
import { formatOutcome } from "../tools/format.ts"
import { Pg } from "./Pg.ts"
import { Store } from "./Store.ts"
import { type Caller, Tools } from "./Tools.ts"

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]
const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0]!

export const JsonRpcCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603
} as const

export type JsonRpcId = string | number | null

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0"
  readonly id: JsonRpcId
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string }
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0"
  readonly method: string
}

/** What one request body comes to. */
export interface McpReply {
  /** The answer: one response, a batch of them, or null when only notifications arrived. */
  readonly response: JsonRpcResponse | Array<JsonRpcResponse> | null
  /** Notifications for the client, on transports that can carry them alongside the answer. */
  readonly notifications: ReadonlyArray<JsonRpcNotification>
}

const TOOLS_CHANGED: JsonRpcNotification = { jsonrpc: "2.0", method: "notifications/tools/list_changed" }

/** One message's answer, and whether handling it changed the tool list. */
interface Handled {
  readonly response: JsonRpcResponse | null
  readonly toolsChanged: boolean
}

const answer = (response: JsonRpcResponse | null, toolsChanged = false): Handled => ({ response, toolsChanged })

const success = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result })

export const failure = (id: JsonRpcId, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message }
})

export class Mcp extends Context.Service<Mcp, {
  /** Handle a request body: a single JSON-RPC message or a batch. */
  handleBody(body: unknown, caller: Caller): Effect.Effect<McpReply>
}>()("postgres2mcp/Mcp") {
  static readonly layer = Layer.effect(
    Mcp,
    Effect.gen(function*() {
      const tools = yield* Tools
      const pg = yield* Pg
      const store = yield* Store

      const instructions = (visible: ReadonlyArray<ToolInfo>, database: string | null) => {
        const names = new Set(visible.map((tool) => tool.name))
        const lines = [
          `This server exposes ${database ? `the PostgreSQL database "${database}"` : "a PostgreSQL database"}.`
        ]
        if (names.has("list_tables")) {
          lines.push("Start with list_tables, then describe_table before writing SQL against a table.")
        }
        if (names.has("query")) {
          lines.push("query runs one read-only statement; results are capped, so aggregate or LIMIT.")
        }
        const custom = visible.filter((tool) => tool.kind === "custom")
        if (custom.length > 0) {
          lines.push(
            `Prefer the purpose-built tools (${custom.map((tool) => tool.name).join(", ")}) when one fits: they were written for this database.`
          )
        }
        if (names.has("create_custom_tool")) {
          lines.push(
            "A query worth asking again can be saved as a tool of its own with create_custom_tool; try it with test_custom_tool first."
          )
        }
        return lines.join(" ")
      }

      const describe = (tool: ToolInfo) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input_schema,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.access === "read",
          destructiveHint: tool.destructive,
          openWorldHint: false
        }
      })

      const callTool = Effect.fn("Mcp.callTool")(function*(id: JsonRpcId, params: unknown, caller: Caller) {
        if (!Predicate.isObject(params) || typeof params.name !== "string") {
          return answer(failure(id, JsonRpcCode.InvalidParams, "tools/call needs a tool name"))
        }
        const args = Predicate.isObject(params.arguments) ? params.arguments as Record<string, unknown> : {}
        // The key's own choice of format, else the server's default.
        const format = caller.format ?? (yield* store.getSettings).result_format
        return yield* tools.call(params.name, args, caller).pipe(
          Effect.map((outcome) =>
            answer(
              success(id, {
                content: formatOutcome(outcome, format).map((text) => ({ type: "text", text })),
                isError: false
              }),
              outcome.toolsChanged === true
            )
          ),
          Effect.catchTags({
            // A tool the key cannot see is, to the client, a tool that does not
            // exist — the protocol-level answer for both is "unknown tool".
            ToolNotFound: (error) => Effect.succeed(answer(failure(id, JsonRpcCode.InvalidParams, error.message))),
            ToolDenied: (error) =>
              Effect.succeed(answer(failure(id, JsonRpcCode.InvalidParams, `Unknown tool: ${error.name}`))),
            // Everything else is a tool-execution error: reported in-band so the
            // model can read what went wrong and try again.
            BadRequest: (error) => Effect.succeed(answer(success(id, toolError(error.message)))),
            QueryError: (error) =>
              Effect.succeed(answer(success(
                id,
                toolError(
                  [
                    error.message,
                    error.detail && `Detail: ${error.detail}`,
                    error.hint && `Hint: ${error.hint}`,
                    error.position !== undefined && `Position: ${error.position}`
                  ].filter(Boolean).join("\n")
                )
              )))
          })
        )
      })

      /**
       * Handle one JSON-RPC message. Notifications, and responses a client
       * sends back, get no reply.
       */
      const handle = Effect.fn("Mcp.handle")(function*(message: unknown, caller: Caller): Effect.fn.Return<Handled> {
        if (!Predicate.isObject(message) || message.jsonrpc !== "2.0") {
          return answer(failure(null, JsonRpcCode.InvalidRequest, "Expected a JSON-RPC 2.0 message"))
        }
        // A response to something we never asked: nothing to say.
        if (typeof message.method !== "string") return answer(null)
        const isNotification = !("id" in message) || message.id === undefined
        const id = (typeof message.id === "string" || typeof message.id === "number") ? message.id : null
        if (isNotification) return answer(null)

        switch (message.method) {
          case "initialize": {
            const requested = Predicate.isObject(message.params) ? message.params.protocolVersion : undefined
            const visible = yield* tools.visibleTo(caller)
            const database = yield* pg.info.pipe(
              Effect.map((info) => info.name),
              Effect.catch(() => Effect.succeed(null))
            )
            return answer(success(id, {
              protocolVersion: typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested)
                ? requested
                : LATEST_PROTOCOL,
              // Only a caller that can change the tool list is ever told it changed.
              capabilities: { tools: { listChanged: visible.some((tool) => TOOL_LIST_CHANGERS.has(tool.name)) } },
              serverInfo: { name: "postgres2mcp", title: "postgres2mcp", version: VERSION },
              instructions: instructions(visible, database)
            }))
          }
          case "ping":
            return answer(success(id, {}))
          case "tools/list": {
            const visible = yield* tools.visibleTo(caller)
            return answer(success(id, { tools: visible.map(describe) }))
          }
          case "tools/call":
            return yield* callTool(id, message.params, caller)
          // Not advertised, but some clients ask anyway — an empty list is kinder than an error.
          case "resources/list":
            return answer(success(id, { resources: [] }))
          case "resources/templates/list":
            return answer(success(id, { resourceTemplates: [] }))
          case "prompts/list":
            return answer(success(id, { prompts: [] }))
          default:
            return answer(failure(id, JsonRpcCode.MethodNotFound, `Method not found: ${message.method}`))
        }
      }, (effect, message) =>
        // A defect must not take the transport down with it; answer and move on.
        Effect.catchCause(effect, (cause) =>
          Effect.logError("MCP request failed", cause).pipe(
            Effect.as(answer(failure(
              Predicate.isObject(message) && (typeof message.id === "string" || typeof message.id === "number")
                ? message.id
                : null,
              JsonRpcCode.InternalError,
              "Internal error"
            )))
          )))

      const handleBody = Effect.fn("Mcp.handleBody")(function*(body: unknown, caller: Caller) {
        const reply = (response: McpReply["response"], toolsChanged: boolean): McpReply => ({
          response,
          notifications: toolsChanged ? [TOOLS_CHANGED] : []
        })
        if (!Array.isArray(body)) {
          const handled = yield* handle(body, caller)
          return reply(handled.response, handled.toolsChanged)
        }
        if (body.length === 0) return reply(failure(null, JsonRpcCode.InvalidRequest, "Empty batch"), false)
        const responses: Array<JsonRpcResponse> = []
        let toolsChanged = false
        for (const message of body) {
          const handled = yield* handle(message, caller)
          if (handled.response !== null) responses.push(handled.response)
          toolsChanged ||= handled.toolsChanged
        }
        return reply(responses.length === 0 ? null : responses, toolsChanged)
      })

      return Mcp.of({ handleBody })
    })
  )
}

const toolError = (text: string) => ({ content: [{ type: "text", text }], isError: true })
