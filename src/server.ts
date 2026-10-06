// One HTTP server, three surfaces:
//
//   /mcp     the MCP endpoint — authenticated per API key
//   /api/*   the admin API    — authenticated by an admin's session
//   /*       the dashboard    — static files, when a build is present
import { BunHttpServer } from "@effect/platform-bun"
import { Effect, Layer, Option, Schedule } from "effect"
import { HttpRouter, HttpServerError, type HttpServerRequest, HttpServerResponse, HttpStaticServer } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "./api/Api.ts"
import { AdminAuthLayer, ApiHandlers } from "./api/handlers.ts"
import { AppConfig } from "./services/AppConfig.ts"
import { Auth } from "./services/Auth.ts"
import { failure, JsonRpcCode, Mcp } from "./services/Mcp.ts"
import { Pg } from "./services/Pg.ts"
import { Store } from "./services/Store.ts"
import { type Caller, Tools } from "./services/Tools.ts"

/** Pg, Store, Auth, Tools and Mcp, wired together. Needs only `AppConfig`. */
export const ServicesLayer = Layer.mergeAll(Mcp.layer, Auth.layer).pipe(
  Layer.provideMerge(Tools.layer),
  Layer.provideMerge(Layer.mergeAll(Pg.layer, Store.layer))
)

// ── /mcp ─────────────────────────────────────────────────────────────────────

// Browser-based MCP clients (the Inspector, web IDEs) call this cross-origin.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-api-key, mcp-protocol-version, mcp-session-id",
  "access-control-max-age": "86400"
}

const tokenFrom = (request: HttpServerRequest.HttpServerRequest): string | null => {
  const authorization = request.headers["authorization"]
  if (authorization !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
    if (match) return match[1]!.trim()
  }
  return request.headers["x-api-key"]?.trim() || null
}

const rpcError = (status: number, code: number, message: string, headers: Record<string, string> = {}) =>
  HttpServerResponse.jsonUnsafe(failure(null, code, message), { status, headers: { ...CORS, ...headers } })

const McpRoutes = HttpRouter.use(Effect.fn(function*(router) {
  const mcp = yield* Mcp
  const store = yield* Store

  yield* router.add("POST", "/mcp", (request) =>
    Effect.gen(function*() {
      const token = tokenFrom(request)
      const key = token === null ? null : yield* store.findKeyByToken(token)
      if (key === null) {
        return rpcError(
          401,
          JsonRpcCode.InvalidRequest,
          token === null
            ? "Missing API key. Send it as: Authorization: Bearer <key>"
            : "Invalid API key",
          { "www-authenticate": "Bearer realm=\"postgres2mcp\"" }
        )
      }
      if (!key.enabled) return rpcError(403, JsonRpcCode.InvalidRequest, "This API key is disabled")

      const body = yield* Effect.result(request.json)
      if (body._tag === "Failure") return rpcError(400, JsonRpcCode.ParseError, "Request body is not valid JSON")

      yield* store.touchKey(key.id)
      const caller: Caller = {
        source: "mcp",
        key_id: key.id,
        key_name: key.name,
        grants: { groups: key.groups, tools: key.tools },
        client: request.headers["user-agent"] ?? null,
        format: key.result_format
      }
      const reply = yield* mcp.handleBody(body.success, caller)
      // Only notifications arrived: acknowledged, nothing to return.
      if (reply.response === null) return HttpServerResponse.empty({ status: 202, headers: CORS })
      // Something for the client besides the answer (its tool list changed):
      // the one case where the answer goes out as a short event stream, the
      // notification first, as the protocol has it.
      if (reply.notifications.length > 0 && (request.headers["accept"] ?? "").includes("text/event-stream")) {
        return HttpServerResponse.text(
          [...reply.notifications, reply.response]
            .map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`)
            .join(""),
          { contentType: "text/event-stream", headers: { ...CORS, "cache-control": "no-store" } }
        )
      }
      return HttpServerResponse.jsonUnsafe(reply.response, { headers: CORS })
    }))

  // Stateless server: no standing SSE stream to open and no session to delete.
  const notAllowed = HttpServerResponse.jsonUnsafe(
    failure(null, JsonRpcCode.InvalidRequest, "Method not allowed. POST JSON-RPC messages to this endpoint."),
    { status: 405, headers: { ...CORS, allow: "POST, OPTIONS" } }
  )
  yield* router.add("GET", "/mcp", notAllowed)
  yield* router.add("DELETE", "/mcp", notAllowed)
  yield* router.add("OPTIONS", "/mcp", HttpServerResponse.empty({ status: 204, headers: CORS }))
}))

// ── /api ─────────────────────────────────────────────────────────────────────

const ApiRoutes = HttpApiBuilder.layer(Api, { openapiPath: "/api/openapi.json" }).pipe(
  Layer.provide(ApiHandlers),
  Layer.provide(AdminAuthLayer)
)

// Without this an unknown /api path would fall through to the dashboard's
// SPA fallback and answer a JSON client with HTML.
const ApiNotFound = HttpRouter.add(
  "*",
  "/api/*",
  HttpServerResponse.jsonUnsafe({ _tag: "NotFound", message: "No such API route" }, { status: 404 })
)

// ── dashboard ────────────────────────────────────────────────────────────────

const Dashboard = Layer.unwrap(Effect.gen(function*() {
  const config = yield* AppConfig
  if (config.webDir !== null) {
    return HttpStaticServer.layer({ root: config.webDir, spa: true })
  }
  return HttpRouter.add(
    "GET",
    "/",
    HttpServerResponse.text(
      "postgres2mcp is running, but no dashboard build was found.\n" +
        "Build it with `bun run build:web`. The admin API is under /api and MCP is at /mcp.\n"
    )
  )
}))

// ── housekeeping ─────────────────────────────────────────────────────────────

// Old log rows and expired sessions are swept once an hour.
const Housekeeping = Layer.effectDiscard(Effect.gen(function*() {
  const store = yield* Store
  yield* store.pruneLogs.pipe(
    Effect.tap((deleted) => deleted > 0 ? Effect.logInfo(`Pruned ${deleted} old log rows`) : Effect.void),
    Effect.andThen(store.pruneSessions),
    Effect.repeat(Schedule.spaced("1 hour")),
    Effect.forkScoped
  )
}))

export const RoutesLayer = Layer.mergeAll(ApiRoutes, ApiNotFound, McpRoutes, Dashboard, Housekeeping)

/** The HTTP server on top of already-built services. */
export const HttpLayer = Layer.unwrap(Effect.gen(function*() {
  const config = yield* AppConfig
  // Tool calls are recorded in the call log; a per-request access log on
  // stdout as well would only bury the lines that matter.
  // …but a request that blows up must still leave a trace.
  return HttpRouter.serve(RoutesLayer, {
    disableLogger: true,
    middleware: (effect) =>
      Effect.tapCause(effect, (cause) => {
        // A malformed request is the client's problem, not ours; only a 5xx is worth a line.
        const [response, stripped] = HttpServerError.causeResponseStripped(cause)
        return response.status >= 500
          ? Effect.logError("Request failed", Option.getOrElse(stripped, () => cause))
          : Effect.void
      })
  }).pipe(
    Layer.provide(BunHttpServer.layer({ port: config.port, hostname: config.host }))
  )
}))

/** The whole server. Needs only `AppConfig`. */
export const ServerLayer = HttpLayer.pipe(Layer.provide(ServicesLayer))
