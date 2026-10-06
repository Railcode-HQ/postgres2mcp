// The admin API's shapes — mirrors src/domain.ts on the server.

export type ParamType = 'string' | 'int' | 'float' | 'bool'
export type ParamValue = string | number | boolean

export interface ToolParam {
  name: string
  type: ParamType
  default?: ParamValue
  description?: string
}

/** A SQL template an admin wrote, exposed to MCP clients as a tool of its own. */
export interface CustomTool {
  name: string
  description: string
  sql: string
  params: ToolParam[]
  allow_writes: boolean
  version: number
  /** Custom groups this tool has been added to. */
  groups: string[]
  created_at: string
  updated_at: string
}

/** How a set of rows is written into an MCP tool result. */
export type ResultFormat = 'compact' | 'objects' | 'markdown' | 'csv'

export interface Settings {
  result_format: ResultFormat
}

export type ToolAccess = 'read' | 'write' | 'admin'

export interface JsonSchema {
  type?: string
  description?: string
  default?: unknown
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
}

export interface ToolInfo {
  name: string
  title: string
  description: string
  kind: 'builtin' | 'custom'
  access: ToolAccess
  destructive: boolean
  groups: string[]
  input_schema: JsonSchema
}

export interface ToolGroup {
  id: string
  name: string
  description: string
  builtin: boolean
  tools: string[]
}

export interface Catalog {
  tools: ToolInfo[]
  groups: ToolGroup[]
}

export interface ApiKey {
  id: string
  name: string
  token_prefix: string
  groups: string[]
  tools: string[]
  enabled: boolean
  created_at: string
  last_used_at: string | null
  /** null follows the server default. */
  result_format: ResultFormat | null
  effective_tools: string[]
}

export interface QueryResult {
  columns: string[]
  rows: unknown[][]
  row_count: number
  truncated: boolean
  command: string | null
  duration_ms: number
}

export type LogStatus = 'ok' | 'error' | 'denied'
export type LogSource = 'mcp' | 'admin' | 'stdio'

export interface LogEntry {
  id: number
  ts: string
  source: LogSource
  key_id: string | null
  key_name: string | null
  tool: string
  kind: 'builtin' | 'custom' | 'sql' | 'unknown'
  status: LogStatus
  duration_ms: number
  row_count: number | null
  error: string | null
  args: string | null
  sql: string | null
  client: string | null
}

export type StatsRange = '1h' | '24h' | '7d' | '30d'

export interface StatsPoint {
  t: string
  ok: number
  errors: number
  denied: number
  avg_ms: number
}

export interface Stats {
  range: StatsRange
  bucket_seconds: number
  totals: {
    calls: number
    ok: number
    errors: number
    denied: number
    rows: number
    avg_ms: number
    p95_ms: number
  }
  series: StatsPoint[]
  by_tool: { tool: string; calls: number; errors: number; avg_ms: number }[]
  by_key: { key_id: string | null; key_name: string; calls: number; errors: number }[]
}

export interface Status {
  version: string
  /** Where clients reach this server, when the operator configured it. */
  public_url: string | null
  database: {
    connected: boolean
    name: string | null
    user: string | null
    host: string | null
    server_version: string | null
    error: string | null
  }
  limits: { max_rows: number; query_timeout_ms: number; log_retention_days: number }
  counts: { tools: number; custom_tools: number; keys: number; groups: number }
}

export interface SchemaTable {
  schema: string
  name: string
  type: string
  columns: { name: string; type: string }[]
}
