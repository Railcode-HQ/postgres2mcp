// The admin API, defined once. The server implements it (src/api/handlers.ts)
// and the dashboard calls these routes over fetch.
import { Context, Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, HttpApiSecurity } from "effect/http-api"
import {
  ApiKey,
  CustomTool,
  LogEntry,
  LogSource,
  LogStatus,
  QueryResult,
  ResultFormat,
  SchemaTable,
  Settings,
  Stats,
  StatsRange,
  Status,
  ToolGroup,
  ToolInfo,
  ToolParam,
  User
} from "../domain.ts"
import { BadRequest, Forbidden, NotFound, QueryError, TooManyAttempts, Unauthorized } from "../errors.ts"

/** The signed-in admin behind a request, as the auth middleware established it. */
export class CurrentSession extends Context.Service<CurrentSession, {
  readonly token: string
  readonly user_id: string
  readonly username: string
  readonly expires_at: number
}>()("postgres2mcp/CurrentSession") {}

/** Guards the admin routes: the bearer must be a live session token. */
export class AdminAuth extends HttpApiMiddleware.Service<AdminAuth, {
  provides: CurrentSession
}>()("postgres2mcp/AdminAuth", {
  requiredForClient: true,
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized
}) {}

const Credentials = Schema.Struct({ username: Schema.String, password: Schema.String })
const SignedIn = Schema.Struct({ token: Schema.String, user: User })

export class AuthApi extends HttpApiGroup.make("auth")
  .add(
    // Public: lets the dashboard tell first-run setup from sign-in.
    HttpApiEndpoint.get("state", "/auth/state", {
      success: Schema.Struct({
        setup_required: Schema.Boolean,
        /** First-run setup needs the code this server was started with. */
        setup_code_required: Schema.Boolean,
        version: Schema.String
      })
    }),
    // Creates the first account. Works exactly once.
    HttpApiEndpoint.post("setup", "/auth/setup", {
      payload: Schema.Struct({ ...Credentials.fields, setup_code: Schema.optionalKey(Schema.String) }),
      success: SignedIn,
      error: [BadRequest, Forbidden]
    }),
    HttpApiEndpoint.post("login", "/auth/login", {
      payload: Credentials,
      success: SignedIn,
      error: [Unauthorized, TooManyAttempts]
    }),
    HttpApiEndpoint.get("me", "/auth/me", {
      success: Schema.Struct({ username: Schema.String })
    }).middleware(AdminAuth),
    HttpApiEndpoint.post("logout", "/auth/logout", {
      success: HttpApiSchema.NoContent
    }).middleware(AdminAuth),
    // Also ends the account's other sessions.
    HttpApiEndpoint.post("password", "/auth/password", {
      payload: Schema.Struct({ current_password: Schema.String, new_password: Schema.String }),
      success: HttpApiSchema.NoContent,
      error: BadRequest
    }).middleware(AdminAuth)
  )
{}

export class SettingsApi extends HttpApiGroup.make("settings")
  .add(
    HttpApiEndpoint.get("get", "/settings", { success: Settings }),
    HttpApiEndpoint.patch("update", "/settings", {
      payload: Schema.Struct({ result_format: Schema.optionalKey(ResultFormat) }),
      success: Settings
    })
  )
  .middleware(AdminAuth)
{}

const Json = Schema.Record(Schema.String, Schema.Unknown)

export class SystemApi extends HttpApiGroup.make("system")
  .add(
    // Public. `database` says whether the target database answers, and no more than that.
    HttpApiEndpoint.get("health", "/health", {
      success: Schema.Struct({ ok: Schema.Boolean, version: Schema.String, database: Schema.Boolean })
    }),
    HttpApiEndpoint.get("status", "/status", { success: Status }).middleware(AdminAuth),
    // Tables and columns for the dashboard's editor. Not a tool call, so not logged.
    HttpApiEndpoint.get("schema", "/schema", {
      success: Schema.Struct({ tables: Schema.Array(SchemaTable) }),
      error: QueryError
    }).middleware(AdminAuth),
    HttpApiEndpoint.get("stats", "/stats", {
      query: { range: Schema.optionalKey(StatsRange) },
      success: Stats
    }).middleware(AdminAuth)
  )
{}

export class ToolsApi extends HttpApiGroup.make("tools")
  .add(
    HttpApiEndpoint.get("list", "/tools", {
      success: Schema.Struct({ tools: Schema.Array(ToolInfo), groups: Schema.Array(ToolGroup) })
    }),
    HttpApiEndpoint.post("call", "/tools/:name/call", {
      params: { name: Schema.String },
      payload: Schema.Struct({ arguments: Schema.optionalKey(Json) }),
      success: Schema.Struct({ data: Schema.Unknown, duration_ms: Schema.Number }),
      error: [NotFound, BadRequest, QueryError]
    })
  )
  .middleware(AdminAuth)
{}

export class GroupsApi extends HttpApiGroup.make("groups")
  .add(
    HttpApiEndpoint.get("list", "/groups", { success: Schema.Array(ToolGroup) }),
    HttpApiEndpoint.post("create", "/groups", {
      payload: Schema.Struct({
        id: Schema.String,
        name: Schema.optionalKey(Schema.String),
        description: Schema.optionalKey(Schema.String),
        tools: Schema.Array(Schema.String)
      }),
      success: ToolGroup,
      error: BadRequest
    }),
    HttpApiEndpoint.patch("update", "/groups/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        description: Schema.optionalKey(Schema.String),
        tools: Schema.optionalKey(Schema.Array(Schema.String))
      }),
      success: ToolGroup,
      error: [NotFound, BadRequest]
    }),
    HttpApiEndpoint.delete("remove", "/groups/:id", {
      params: { id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: [NotFound, BadRequest]
    })
  )
  .middleware(AdminAuth)
{}

export class KeysApi extends HttpApiGroup.make("keys")
  .add(
    HttpApiEndpoint.get("list", "/keys", { success: Schema.Array(ApiKey) }),
    HttpApiEndpoint.post("create", "/keys", {
      payload: Schema.Struct({
        name: Schema.String,
        groups: Schema.optionalKey(Schema.Array(Schema.String)),
        tools: Schema.optionalKey(Schema.Array(Schema.String)),
        result_format: Schema.optionalKey(Schema.NullOr(ResultFormat))
      }),
      // The token is returned exactly once; only its hash is stored.
      success: Schema.Struct({ key: ApiKey, token: Schema.String }),
      error: BadRequest
    }),
    HttpApiEndpoint.patch("update", "/keys/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        groups: Schema.optionalKey(Schema.Array(Schema.String)),
        tools: Schema.optionalKey(Schema.Array(Schema.String)),
        enabled: Schema.optionalKey(Schema.Boolean),
        // null clears the override and follows the server default again.
        result_format: Schema.optionalKey(Schema.NullOr(ResultFormat))
      }),
      success: ApiKey,
      error: [NotFound, BadRequest]
    }),
    HttpApiEndpoint.delete("remove", "/keys/:id", {
      params: { id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: NotFound
    })
  )
  .middleware(AdminAuth)
{}

export class CustomToolsApi extends HttpApiGroup.make("customTools")
  .add(
    HttpApiEndpoint.get("list", "/custom-tools", { success: Schema.Array(CustomTool) }),
    HttpApiEndpoint.get("get", "/custom-tools/:name", {
      params: { name: Schema.String },
      success: CustomTool,
      error: NotFound
    }),
    HttpApiEndpoint.post("create", "/custom-tools", {
      payload: Schema.Struct({
        name: Schema.String,
        sql: Schema.String,
        description: Schema.optionalKey(Schema.String),
        // Omitted params are derived from the SQL: every :name becomes a string param.
        params: Schema.optionalKey(Schema.Array(ToolParam)),
        allow_writes: Schema.optionalKey(Schema.Boolean),
        // Custom groups to add the tool to.
        groups: Schema.optionalKey(Schema.Array(Schema.String))
      }),
      success: CustomTool,
      error: BadRequest
    }),
    HttpApiEndpoint.patch("update", "/custom-tools/:name", {
      params: { name: Schema.String },
      payload: Schema.Struct({
        sql: Schema.optionalKey(Schema.String),
        description: Schema.optionalKey(Schema.String),
        params: Schema.optionalKey(Schema.Array(ToolParam)),
        allow_writes: Schema.optionalKey(Schema.Boolean),
        // When given, the tool ends up in exactly these custom groups.
        groups: Schema.optionalKey(Schema.Array(Schema.String))
      }),
      success: CustomTool,
      error: [NotFound, BadRequest]
    }),
    HttpApiEndpoint.delete("remove", "/custom-tools/:name", {
      params: { name: Schema.String },
      success: HttpApiSchema.NoContent,
      error: NotFound
    }),
    HttpApiEndpoint.post("run", "/custom-tools/:name/run", {
      params: { name: Schema.String },
      payload: Schema.Struct({ params: Schema.optionalKey(Json) }),
      success: QueryResult,
      error: [NotFound, BadRequest, QueryError]
    }),
    // Dry-run an unsaved draft — the editor's Run button. Nothing is stored.
    HttpApiEndpoint.post("test", "/custom-tool-drafts/test", {
      payload: Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        sql: Schema.String,
        params: Schema.optionalKey(Schema.Array(ToolParam)),
        values: Schema.optionalKey(Json),
        allow_writes: Schema.optionalKey(Schema.Boolean)
      }),
      success: QueryResult,
      error: [BadRequest, QueryError]
    })
  )
  .middleware(AdminAuth)
{}

export class SqlApi extends HttpApiGroup.make("sql")
  .add(
    HttpApiEndpoint.post("run", "/sql", {
      payload: Schema.Struct({
        sql: Schema.String,
        params: Schema.optionalKey(Schema.Array(Schema.Unknown)),
        allow_writes: Schema.optionalKey(Schema.Boolean)
      }),
      success: QueryResult,
      error: [BadRequest, QueryError]
    })
  )
  .middleware(AdminAuth)
{}

export class LogsApi extends HttpApiGroup.make("logs")
  .add(
    HttpApiEndpoint.get("list", "/logs", {
      query: {
        limit: Schema.optionalKey(Schema.FiniteFromString),
        before: Schema.optionalKey(Schema.FiniteFromString),
        tool: Schema.optionalKey(Schema.String),
        key_id: Schema.optionalKey(Schema.String),
        status: Schema.optionalKey(LogStatus),
        source: Schema.optionalKey(LogSource),
        q: Schema.optionalKey(Schema.String)
      },
      success: Schema.Struct({
        logs: Schema.Array(LogEntry),
        /** Pass as `before` to fetch the next (older) page; null at the end. */
        next_before: Schema.NullOr(Schema.Int)
      })
    }),
    HttpApiEndpoint.get("get", "/logs/:id", {
      params: { id: Schema.FiniteFromString },
      success: LogEntry,
      error: NotFound
    }),
    HttpApiEndpoint.delete("clear", "/logs", {
      success: Schema.Struct({ deleted: Schema.Int })
    })
  )
  .middleware(AdminAuth)
{}

export class Api extends HttpApi.make("postgres2mcp")
  .add(AuthApi)
  .add(SystemApi)
  .add(SettingsApi)
  .add(ToolsApi)
  .add(CustomToolsApi)
  .add(GroupsApi)
  .add(KeysApi)
  .add(SqlApi)
  .add(LogsApi)
  .prefix("/api")
{}
