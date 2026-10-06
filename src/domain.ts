// The shapes that cross a boundary: the admin API (the dashboard), the
// SQLite store, and the MCP surface all speak these.
import { Schema } from "effect"

// ── result formats ───────────────────────────────────────────────────────────

/**
 * How a set of rows is written into an MCP tool result.
 *
 * - `compact`  JSON with a `columns` header and each row as an array — the fewest tokens
 * - `objects`  JSON with one object per row — self-describing, more tokens
 * - `markdown` a Markdown table
 * - `csv`      CSV with a header row
 */
export const ResultFormat = Schema.Literals(["compact", "objects", "markdown", "csv"])
export type ResultFormat = typeof ResultFormat.Type

// ── custom tools ─────────────────────────────────────────────────────────────

export const ParamType = Schema.Literals(["string", "int", "float", "bool"])
export type ParamType = typeof ParamType.Type

export const ParamValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean])
export type ParamValue = typeof ParamValue.Type

/**
 * One `:name` placeholder of a custom tool. A `default` makes the param
 * optional at call time; `description` is what the MCP client's model reads.
 */
export const ToolParam = Schema.Struct({
  name: Schema.String,
  type: ParamType,
  default: Schema.optional(ParamValue),
  description: Schema.optional(Schema.String)
})
export type ToolParam = typeof ToolParam.Type

/** A SQL template written on this server, exposed to MCP clients as a tool of its own. */
export const CustomTool = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  sql: Schema.String,
  params: Schema.Array(ToolParam),
  /** Off by default: the tool runs in a read-only transaction. */
  allow_writes: Schema.Boolean,
  /** Bumped on every SQL/params edit. */
  version: Schema.Int,
  /** Custom groups this tool has been added to. */
  groups: Schema.Array(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String
})
export type CustomTool = typeof CustomTool.Type

// ── tools + groups ───────────────────────────────────────────────────────────

/**
 * What a tool can do — drives MCP annotations and the UI badge. `admin` covers
 * the operational commands and the tools that change the server's own tools.
 */
export const ToolAccess = Schema.Literals(["read", "write", "admin"])
export type ToolAccess = typeof ToolAccess.Type

export const ToolInfo = Schema.Struct({
  name: Schema.String,
  title: Schema.String,
  description: Schema.String,
  kind: Schema.Literals(["builtin", "custom"]),
  access: ToolAccess,
  /** May irreversibly change or remove data (MCP's destructiveHint). */
  destructive: Schema.Boolean,
  /** Ids of every group this tool belongs to. */
  groups: Schema.Array(Schema.String),
  input_schema: Schema.Unknown
})
export type ToolInfo = typeof ToolInfo.Type

export const ToolGroup = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  /** Built-in groups ship with the server and cannot be edited. */
  builtin: Schema.Boolean,
  /** Resolved tool names. */
  tools: Schema.Array(Schema.String)
})
export type ToolGroup = typeof ToolGroup.Type

// ── API keys ─────────────────────────────────────────────────────────────────

export const ApiKey = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** First characters of the token, enough to recognise it in a list. */
  token_prefix: Schema.String,
  groups: Schema.Array(Schema.String),
  tools: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
  created_at: Schema.String,
  last_used_at: Schema.NullOr(Schema.String),
  /** How results are written for this key; null follows the server default. */
  result_format: Schema.NullOr(ResultFormat),
  /** Tool names this key can call right now (groups ∪ tools, resolved). */
  effective_tools: Schema.Array(Schema.String)
})
export type ApiKey = typeof ApiKey.Type

// ── query results ────────────────────────────────────────────────────────────

export const QueryResult = Schema.Struct({
  columns: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Array(Schema.Unknown)),
  row_count: Schema.Int,
  /** The row or byte cap cut the result short. */
  truncated: Schema.Boolean,
  /** The command tag Postgres reported (SELECT, INSERT, …), when known. */
  command: Schema.NullOr(Schema.String),
  duration_ms: Schema.Number
})
export type QueryResult = typeof QueryResult.Type

// ── logs + stats ─────────────────────────────────────────────────────────────

export const LogStatus = Schema.Literals(["ok", "error", "denied"])
export type LogStatus = typeof LogStatus.Type

/** Where a call came from: an MCP client holding a key, an admin in the dashboard, or the stdio transport. */
export const LogSource = Schema.Literals(["mcp", "admin", "stdio"])
export type LogSource = typeof LogSource.Type

export const LogEntry = Schema.Struct({
  id: Schema.Int,
  ts: Schema.String,
  source: LogSource,
  key_id: Schema.NullOr(Schema.String),
  key_name: Schema.NullOr(Schema.String),
  tool: Schema.String,
  kind: Schema.Literals(["builtin", "custom", "sql", "unknown"]),
  status: LogStatus,
  duration_ms: Schema.Number,
  row_count: Schema.NullOr(Schema.Int),
  error: Schema.NullOr(Schema.String),
  /** Arguments as the caller sent them (JSON text, possibly truncated). */
  args: Schema.NullOr(Schema.String),
  /** The SQL that reached Postgres, when the tool is SQL-shaped. */
  sql: Schema.NullOr(Schema.String),
  client: Schema.NullOr(Schema.String)
})
export type LogEntry = typeof LogEntry.Type

export const StatsRange = Schema.Literals(["1h", "24h", "7d", "30d"])
export type StatsRange = typeof StatsRange.Type

export const Stats = Schema.Struct({
  range: StatsRange,
  bucket_seconds: Schema.Int,
  totals: Schema.Struct({
    calls: Schema.Int,
    ok: Schema.Int,
    errors: Schema.Int,
    denied: Schema.Int,
    rows: Schema.Int,
    avg_ms: Schema.Number,
    p95_ms: Schema.Number
  }),
  series: Schema.Array(Schema.Struct({
    t: Schema.String,
    ok: Schema.Int,
    errors: Schema.Int,
    denied: Schema.Int,
    avg_ms: Schema.Number
  })),
  by_tool: Schema.Array(Schema.Struct({
    tool: Schema.String,
    calls: Schema.Int,
    errors: Schema.Int,
    avg_ms: Schema.Number
  })),
  by_key: Schema.Array(Schema.Struct({
    key_id: Schema.NullOr(Schema.String),
    key_name: Schema.String,
    calls: Schema.Int,
    errors: Schema.Int
  }))
})
export type Stats = typeof Stats.Type

// ── server status ────────────────────────────────────────────────────────────

export const Status = Schema.Struct({
  version: Schema.String,
  /** Where clients reach this server, when the operator said so (P2M_PUBLIC_URL). */
  public_url: Schema.NullOr(Schema.String),
  database: Schema.Struct({
    connected: Schema.Boolean,
    name: Schema.NullOr(Schema.String),
    user: Schema.NullOr(Schema.String),
    host: Schema.NullOr(Schema.String),
    server_version: Schema.NullOr(Schema.String),
    error: Schema.NullOr(Schema.String)
  }),
  limits: Schema.Struct({
    max_rows: Schema.Int,
    query_timeout_ms: Schema.Int,
    log_retention_days: Schema.Int
  }),
  counts: Schema.Struct({
    tools: Schema.Int,
    custom_tools: Schema.Int,
    keys: Schema.Int,
    groups: Schema.Int
  })
})
export type Status = typeof Status.Type

// ── schema snapshot (dashboard autocomplete + browser) ───────────────────────

export const SchemaTable = Schema.Struct({
  schema: Schema.String,
  name: Schema.String,
  type: Schema.String,
  columns: Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String }))
})
export type SchemaTable = typeof SchemaTable.Type

// ── settings + accounts ──────────────────────────────────────────────────────

export const Settings = Schema.Struct({
  /** The format a key gets when it does not choose its own. */
  result_format: ResultFormat
})
export type Settings = typeof Settings.Type

export const User = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
  created_at: Schema.String
})
export type User = typeof User.Type

// ── naming rules ─────────────────────────────────────────────────────────────

/** A custom tool's name is the MCP tool name. */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/
export const GROUP_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/
export const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
export const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/
export const MIN_PASSWORD_LENGTH = 8
