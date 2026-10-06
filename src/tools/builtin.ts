// The tools every postgres2mcp server ships with. Each one is a schema for its
// arguments plus a handler that turns them into one statement against `Pg`.
import { Effect, Schema } from "effect"
import type { QueryResult, ToolAccess } from "../domain.ts"
import { BadRequest, type QueryError } from "../errors.ts"
import type { Pg } from "../services/Pg.ts"
import { hasMultipleStatements, isBlank, qualified } from "../sql/sqltext.ts"

/** What a tool hands back: the payload for the caller, and what to log. */
export interface ToolOutcome {
  /** The answer as plain JSON — what the admin API shows. */
  readonly data: unknown
  /**
   * Set when the answer is a set of rows. An MCP result is then written from
   * this in the caller's result format instead of from `data`.
   */
  readonly rows?: QueryResult
  readonly sql: string | null
  readonly row_count: number | null
  /** The call added, changed or removed a tool: clients should list tools again. */
  readonly toolsChanged?: boolean
}

/** What a tool may ask about whoever is calling it. */
export interface ToolContext {
  /** Whether the caller may call the named tool right now. */
  readonly holds: (tool: string) => Effect.Effect<boolean>
}

export interface BuiltinTool {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly group: BuiltinGroupId
  readonly access: ToolAccess
  /** May irreversibly change or remove data. */
  readonly destructive: boolean
  readonly inputSchema: Record<string, unknown>
  /** Decode raw arguments and run. Argument problems surface as `BadRequest`. */
  readonly run: (
    args: Record<string, unknown>,
    context: ToolContext
  ) => Effect.Effect<ToolOutcome, QueryError | BadRequest>
}

export const BUILTIN_GROUPS = [
  {
    id: "schema",
    name: "Schema explorer",
    description: "Explore schemas, tables, columns and relationships. These tools do not read row data."
  },
  {
    id: "read",
    name: "Read-only SQL",
    description: "Run arbitrary SQL inside a read-only transaction."
  },
  {
    id: "write",
    name: "Write SQL",
    description: "Run arbitrary SQL that can change data and schema."
  },
  {
    id: "monitoring",
    name: "Monitoring",
    description: "Database health: sizes, activity, table and index statistics."
  },
  {
    id: "admin",
    name: "Admin tools",
    description: "Destructive and operational commands: DROP, TRUNCATE, VACUUM, CANCEL."
  },
  {
    id: "authoring",
    name: "Tool authoring",
    description: "Enables the client to create custom tools. Consequently allows read access to the whole database."
  },
  {
    id: "custom",
    name: "Custom tools",
    description: "Every custom tool, including ones added later."
  },
  {
    id: "all",
    name: "Everything",
    description: "Every tool on this server, including ones added later."
  }
] as const

export type BuiltinGroupId = (typeof BUILTIN_GROUPS)[number]["id"]

export const isBuiltinGroup = (id: string): boolean => BUILTIN_GROUPS.some((group) => group.id === id)

// ── argument schemas ─────────────────────────────────────────────────────────

const SchemaName = Schema.optionalKey(Schema.String.annotate({
  description: "Schema name. Defaults to \"public\"."
}))

const SchemaFilter = Schema.optionalKey(Schema.String.annotate({
  description: "Only this schema. Omit for every non-system schema."
}))

const TableName = Schema.String.annotate({ description: "Table name, without the schema." })

const SqlText = Schema.String.annotate({
  description: "One SQL statement. Use $1, $2, … for values passed in `params`."
})

const SqlParams = Schema.optionalKey(Schema.Array(Schema.Unknown).annotate({
  description: "Values bound to $1, $2, … in order."
}))

const NoArgs = Schema.Struct({})

// ── construction ─────────────────────────────────────────────────────────────

interface Definition<S extends Schema.Top> {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly group: BuiltinGroupId
  readonly access: ToolAccess
  /** Defaults to "anything that is not read-only". */
  readonly destructive?: boolean
  readonly input: S
  readonly handler: (args: S["Type"], context: ToolContext) => Effect.Effect<ToolOutcome, QueryError | BadRequest>
}

export function define<S extends Schema.Top & { readonly DecodingServices: never }>(
  definition: Definition<S>
): BuiltinTool {
  const decode = Schema.decodeUnknownEffect(definition.input)
  const document = Schema.toJsonSchemaDocument(definition.input)
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    group: definition.group,
    access: definition.access,
    destructive: definition.destructive ?? definition.access !== "read",
    inputSchema: toInputSchema(document.schema as Record<string, unknown>),
    run: (args, context) =>
      decode(args, { errors: "all", onExcessProperty: "error" }).pipe(
        Effect.mapError((error) => new BadRequest({ message: `Invalid arguments: ${error.message}` })),
        Effect.flatMap((decoded) => definition.handler(decoded, context))
      )
  }
}

/** MCP wants an object schema; a tool without arguments is an object with no properties. */
const toInputSchema = (schema: Record<string, unknown>): Record<string, unknown> =>
  schema.type === "object"
    ? closed(schema) as Record<string, unknown>
    : { type: "object", properties: {}, additionalProperties: false }

/** Arguments are decoded strictly, so say so: every object with named properties takes only those. */
const closed = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(closed)
  if (typeof node !== "object" || node === null) return node
  const copy = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, closed(value)]))
  return copy.type === "object" && "properties" in copy ? { ...copy, additionalProperties: false } : copy
}

/** Rows as objects — friendlier than columns + arrays for small catalog answers. */
const objects = (result: QueryResult): Array<Record<string, unknown>> =>
  result.rows.map((row) => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])))

/** The shape SQL-running tools return: compact, and explicit about truncation. */
export const tabular = (result: QueryResult) => ({
  columns: result.columns,
  rows: result.rows,
  row_count: result.row_count,
  ...(result.command !== null && result.columns.length === 0 ? { command: result.command } : {}),
  ...(result.truncated
    ? { truncated: true, note: "Result was cut at the row/size limit. Narrow the query or add LIMIT." }
    : {})
})

const checkStatement = (sql: string): Effect.Effect<void, BadRequest> => {
  if (isBlank(sql)) return Effect.fail(new BadRequest({ message: "SQL is required" }))
  if (hasMultipleStatements(sql)) {
    return Effect.fail(new BadRequest({ message: "Only a single SQL statement is allowed per call" }))
  }
  return Effect.void
}

const NOT_SYSTEM = `n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'`

const RELKIND = `CASE c.relkind
  WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table' WHEN 'v' THEN 'view'
  WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table' END`

export function makeBuiltins(pg: Pg["Service"]): Array<BuiltinTool> {
  const read = (sql: string, params: ReadonlyArray<unknown> = []) => pg.run(sql, params, { readOnly: true })

  /** Run catalog SQL and answer with `{ [key]: rows-as-objects }`. */
  const catalog = (key: string, sql: string, params: ReadonlyArray<unknown> = []) =>
    read(sql, params).pipe(
      Effect.map((result): ToolOutcome => ({
        data: { [key]: objects(result), ...(result.truncated ? { truncated: true } : {}) },
        rows: result,
        sql,
        row_count: result.row_count
      }))
    )

  return [
    // ── schema ───────────────────────────────────────────────────────────────
    define({
      name: "list_schemas",
      title: "List schemas",
      description: "List the schemas in the database with how many tables and views each holds.",
      group: "schema",
      access: "read",
      input: NoArgs,
      handler: () =>
        catalog(
          "schemas",
          `SELECT n.nspname AS schema,
       pg_get_userbyid(n.nspowner) AS owner,
       (SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p')) AS tables,
       (SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('v', 'm')) AS views
FROM pg_namespace n
WHERE ${NOT_SYSTEM}
ORDER BY 1`
        )
    }),
    define({
      name: "list_tables",
      title: "List tables",
      description:
        "List tables and views with their type, estimated row count, size on disk and comment. Start here to learn what the database holds.",
      group: "schema",
      access: "read",
      input: Schema.Struct({ schema: SchemaFilter }),
      handler: ({ schema }) =>
        catalog(
          "tables",
          `SELECT n.nspname AS schema,
       c.relname AS name,
       ${RELKIND} AS type,
       CASE WHEN c.relkind IN ('r', 'p', 'm') AND c.reltuples >= 0 THEN c.reltuples::bigint END AS estimated_rows,
       CASE WHEN c.relkind IN ('r', 'p', 'm') THEN pg_size_pretty(pg_total_relation_size(c.oid)) END AS size,
       obj_description(c.oid, 'pg_class') AS comment
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND NOT c.relispartition
  AND ${NOT_SYSTEM}
  AND ($1::text IS NULL OR n.nspname = $1)
ORDER BY 1, 2`,
          [schema ?? null]
        )
    }),
    define({
      name: "describe_table",
      title: "Describe table",
      description:
        "Everything about one table or view: columns with types, defaults and enum values, primary key, foreign keys in both directions, constraints and indexes.",
      group: "schema",
      access: "read",
      input: Schema.Struct({ table: TableName, schema: SchemaName }),
      handler: ({ schema, table }) => {
        const sql = DESCRIBE_TABLE
        return read(sql, [schema ?? "public", table]).pipe(
          Effect.flatMap((result) => {
            const description = result.rows[0]?.[0]
            if (description === undefined || description === null) {
              return Effect.fail(
                new BadRequest({
                  message: `Table "${schema ?? "public"}.${table}" not found. Use list_tables to see what exists.`
                })
              )
            }
            return Effect.succeed<ToolOutcome>({ data: description, sql, row_count: 1 })
          })
        )
      }
    }),
    define({
      name: "list_relationships",
      title: "List relationships",
      description: "List foreign keys between tables — which columns join which tables.",
      group: "schema",
      access: "read",
      input: Schema.Struct({ schema: SchemaFilter }),
      handler: ({ schema }) =>
        catalog(
          "relationships",
          `SELECT con.conname AS name,
       n.nspname || '.' || c.relname AS from_table,
       (SELECT array_agg(a.attname::text ORDER BY k.ord)
          FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS from_columns,
       fn.nspname || '.' || fc.relname AS to_table,
       (SELECT array_agg(a.attname::text ORDER BY k.ord)
          FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS to_columns
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_class fc ON fc.oid = con.confrelid
JOIN pg_namespace fn ON fn.oid = fc.relnamespace
WHERE con.contype = 'f'
  AND ${NOT_SYSTEM}
  AND ($1::text IS NULL OR n.nspname = $1)
ORDER BY 2, 1`,
          [schema ?? null]
        )
    }),
    define({
      name: "search_schema",
      title: "Search schema",
      description:
        "Find tables and columns whose name contains a term (case-insensitive). Use it when you know a concept (\"email\", \"invoice\") but not where it lives.",
      group: "schema",
      access: "read",
      input: Schema.Struct({
        term: Schema.String.annotate({ description: "Text to look for in table and column names." })
      }),
      handler: ({ term }) => {
        const pattern = `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
        return catalog(
          "matches",
          `SELECT n.nspname AS schema, c.relname AS "table", NULL::text AS "column", ${RELKIND} AS type
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND ${NOT_SYSTEM} AND c.relname ILIKE $1
UNION ALL
SELECT n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod)
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND ${NOT_SYSTEM}
  AND a.attnum > 0 AND NOT a.attisdropped AND a.attname ILIKE $1
ORDER BY 1, 2, 3 NULLS FIRST
LIMIT 200`,
          [pattern]
        )
      }
    }),

    // ── read ─────────────────────────────────────────────────────────────────
    define({
      name: "query",
      title: "Run read-only SQL",
      description:
        "Run one SQL statement in a read-only transaction and return its rows. Writes are rejected by Postgres. Results are capped, so aggregate or LIMIT large tables.",
      group: "read",
      access: "read",
      input: Schema.Struct({ sql: SqlText, params: SqlParams }),
      handler: ({ params, sql }) =>
        checkStatement(sql).pipe(
          Effect.andThen(read(sql, params ?? [])),
          Effect.map((result): ToolOutcome => ({ data: tabular(result), rows: result, sql, row_count: result.row_count }))
        )
    }),
    define({
      name: "explain_query",
      title: "Explain query",
      description:
        "Show the execution plan Postgres would use for a statement. With analyze=true the statement is actually run (still read-only) and real timings are reported.",
      group: "read",
      access: "read",
      input: Schema.Struct({
        sql: SqlText,
        params: SqlParams,
        analyze: Schema.optionalKey(Schema.Boolean.annotate({
          description: "Execute the statement and report actual timings. Defaults to false."
        }))
      }),
      handler: ({ analyze, params, sql }) => {
        const explain = `EXPLAIN ${analyze ? "(ANALYZE, BUFFERS) " : ""}${sql}`
        return checkStatement(sql).pipe(
          Effect.andThen(read(explain, params ?? [])),
          Effect.map((result): ToolOutcome => ({
            data: { plan: result.rows.map((row) => String(row[0])).join("\n") },
            sql: explain,
            row_count: null
          }))
        )
      }
    }),

    // ── write ────────────────────────────────────────────────────────────────
    define({
      name: "execute_sql",
      title: "Run SQL (read-write)",
      description:
        "Run one SQL statement that may change data or schema (INSERT, UPDATE, DELETE, DDL). Committed immediately. Returns rows for RETURNING/SELECT, otherwise the affected row count.",
      group: "write",
      access: "write",
      input: Schema.Struct({ sql: SqlText, params: SqlParams }),
      handler: ({ params, sql }) =>
        checkStatement(sql).pipe(
          Effect.andThen(pg.run(sql, params ?? [], { readOnly: false })),
          Effect.map((result): ToolOutcome => ({ data: tabular(result), rows: result, sql, row_count: result.row_count }))
        )
    }),

    // ── monitoring ───────────────────────────────────────────────────────────
    define({
      name: "database_stats",
      title: "Database stats",
      description:
        "One-shot health summary: version, size, connections in use, cache hit ratio, transaction and deadlock counters.",
      group: "monitoring",
      access: "read",
      input: NoArgs,
      handler: () => {
        const sql = DATABASE_STATS
        return read(sql).pipe(
          Effect.map((result): ToolOutcome => ({ data: result.rows[0]?.[0] ?? {}, sql, row_count: 1 }))
        )
      }
    }),
    define({
      name: "table_stats",
      title: "Table stats",
      description:
        "Per-table size, live and dead row counts, sequential vs index scans, and when each was last vacuumed and analyzed. Largest first.",
      group: "monitoring",
      access: "read",
      input: Schema.Struct({ schema: SchemaFilter }),
      handler: ({ schema }) =>
        catalog(
          "tables",
          `SELECT s.schemaname AS schema,
       s.relname AS name,
       pg_size_pretty(pg_total_relation_size(s.relid)) AS total_size,
       pg_size_pretty(pg_indexes_size(s.relid)) AS index_size,
       s.n_live_tup AS live_rows,
       s.n_dead_tup AS dead_rows,
       s.seq_scan AS seq_scans,
       s.idx_scan AS index_scans,
       GREATEST(s.last_vacuum, s.last_autovacuum) AS last_vacuum,
       GREATEST(s.last_analyze, s.last_autoanalyze) AS last_analyze
FROM pg_stat_user_tables s
WHERE ($1::text IS NULL OR s.schemaname = $1)
ORDER BY pg_total_relation_size(s.relid) DESC
LIMIT 100`,
          [schema ?? null]
        )
    }),
    define({
      name: "index_stats",
      title: "Index stats",
      description:
        "Per-index size and scan count. Indexes with zero scans are candidates for removal; large tables with many sequential scans may be missing one.",
      group: "monitoring",
      access: "read",
      input: Schema.Struct({ schema: SchemaFilter }),
      handler: ({ schema }) =>
        catalog(
          "indexes",
          `SELECT s.schemaname AS schema,
       s.relname AS "table",
       s.indexrelname AS name,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
       s.idx_scan AS scans,
       i.indisunique AS is_unique,
       i.indisprimary AS is_primary,
       pg_get_indexdef(s.indexrelid) AS definition
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE ($1::text IS NULL OR s.schemaname = $1)
ORDER BY pg_relation_size(s.indexrelid) DESC
LIMIT 200`,
          [schema ?? null]
        )
    }),
    define({
      name: "active_queries",
      title: "Active queries",
      description:
        "What is running right now: each non-idle connection with its state, how long it has been running, what it waits on, and its SQL.",
      group: "monitoring",
      access: "read",
      input: NoArgs,
      handler: () =>
        catalog(
          "queries",
          `SELECT pid,
       usename AS "user",
       application_name AS application,
       client_addr::text AS client,
       state,
       wait_event_type,
       wait_event,
       (now() - query_start)::text AS running_for,
       left(query, 1000) AS query
FROM pg_stat_activity
WHERE datname = current_database()
  AND pid <> pg_backend_pid()
  AND state IS DISTINCT FROM 'idle'
ORDER BY query_start NULLS LAST`
        )
    }),

    // ── admin ────────────────────────────────────────────────────────────────
    define({
      name: "truncate_table",
      title: "Truncate table",
      description: "Delete every row of a table. Irreversible. The table and its structure stay.",
      group: "admin",
      access: "admin",
      input: Schema.Struct({
        table: TableName,
        schema: SchemaName,
        cascade: Schema.optionalKey(Schema.Boolean.annotate({
          description: "Also truncate tables that reference this one through foreign keys."
        })),
        restart_identity: Schema.optionalKey(Schema.Boolean.annotate({
          description: "Reset the table's sequences back to their start."
        }))
      }),
      handler: ({ cascade, restart_identity, schema, table }) => {
        const sql = `TRUNCATE TABLE ${qualified(schema ?? "public", table)}${
          restart_identity ? " RESTART IDENTITY" : ""
        }${cascade ? " CASCADE" : ""}`
        return pg.run(sql, [], { readOnly: false }).pipe(
          Effect.map((): ToolOutcome => ({
            data: { ok: true, truncated: `${schema ?? "public"}.${table}` },
            sql,
            row_count: null
          }))
        )
      }
    }),
    define({
      name: "drop_table",
      title: "Drop table",
      description: "Drop a table and all of its data. Irreversible.",
      group: "admin",
      access: "admin",
      input: Schema.Struct({
        table: TableName,
        schema: SchemaName,
        cascade: Schema.optionalKey(Schema.Boolean.annotate({
          description: "Also drop objects that depend on the table (views, foreign keys)."
        })),
        if_exists: Schema.optionalKey(Schema.Boolean.annotate({
          description: "Succeed quietly when the table does not exist."
        }))
      }),
      handler: ({ cascade, if_exists, schema, table }) => {
        const sql = `DROP TABLE ${if_exists ? "IF EXISTS " : ""}${qualified(schema ?? "public", table)}${
          cascade ? " CASCADE" : ""
        }`
        return pg.run(sql, [], { readOnly: false }).pipe(
          Effect.map((): ToolOutcome => ({
            data: { ok: true, dropped: `${schema ?? "public"}.${table}` },
            sql,
            row_count: null
          }))
        )
      }
    }),
    define({
      name: "vacuum_analyze",
      title: "Vacuum and analyze",
      description: "Reclaim dead rows in a table and refresh the planner's statistics for it.",
      group: "admin",
      access: "admin",
      destructive: false,
      input: Schema.Struct({ table: TableName, schema: SchemaName }),
      handler: ({ schema, table }) => {
        const sql = `VACUUM (ANALYZE) ${qualified(schema ?? "public", table)}`
        // VACUUM refuses to run inside a transaction block.
        return pg.run(sql, [], { readOnly: false, noTransaction: true }).pipe(
          Effect.map((): ToolOutcome => ({
            data: { ok: true, vacuumed: `${schema ?? "public"}.${table}` },
            sql,
            row_count: null
          }))
        )
      }
    }),
    define({
      name: "cancel_query",
      title: "Cancel query",
      description:
        "Cancel the statement a backend is running, found by pid via active_queries. With terminate=true the whole connection is closed instead.",
      group: "admin",
      access: "admin",
      destructive: false,
      input: Schema.Struct({
        pid: Schema.Int.annotate({ description: "Backend process id, from active_queries." }),
        terminate: Schema.optionalKey(Schema.Boolean.annotate({
          description: "Close the connection instead of only cancelling its statement."
        }))
      }),
      handler: ({ pid, terminate }) => {
        const sql = `SELECT ${terminate ? "pg_terminate_backend" : "pg_cancel_backend"}($1)`
        return read(sql, [pid]).pipe(
          Effect.map((result): ToolOutcome => ({
            data: { ok: result.rows[0]?.[0] === true, pid, action: terminate ? "terminated" : "cancelled" },
            sql,
            row_count: null
          }))
        )
      }
    })
  ]
}

const DESCRIBE_TABLE = `WITH t AS (
  SELECT c.oid, c.relkind, c.reltuples, n.nspname, c.relname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
)
SELECT json_build_object(
  'schema', t.nspname,
  'name', t.relname,
  'type', CASE t.relkind
    WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table' WHEN 'v' THEN 'view'
    WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table' END,
  'comment', obj_description(t.oid, 'pg_class'),
  'estimated_rows', CASE WHEN t.relkind IN ('r', 'p', 'm') AND t.reltuples >= 0 THEN t.reltuples::bigint END,
  'columns', (
    SELECT coalesce(json_agg(json_strip_nulls(json_build_object(
      'name', a.attname,
      'type', format_type(a.atttypid, a.atttypmod),
      'nullable', NOT a.attnotnull,
      'default', pg_get_expr(d.adbin, d.adrelid),
      'identity', CASE WHEN a.attidentity <> '' THEN true END,
      'enum_values', (SELECT json_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = a.atttypid),
      'comment', col_description(a.attrelid, a.attnum)
    )) ORDER BY a.attnum), '[]'::json)
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
  ),
  'primary_key', (
    SELECT json_agg(a.attname ORDER BY k.ord)
    FROM pg_index i
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
    WHERE i.indrelid = t.oid AND i.indisprimary
  ),
  'foreign_keys', (
    SELECT coalesce(json_agg(json_build_object(
      'name', con.conname,
      'references', con.confrelid::regclass::text,
      'definition', pg_get_constraintdef(con.oid)
    ) ORDER BY con.conname), '[]'::json)
    FROM pg_constraint con WHERE con.conrelid = t.oid AND con.contype = 'f'
  ),
  'referenced_by', (
    SELECT coalesce(json_agg(json_build_object(
      'table', con.conrelid::regclass::text,
      'name', con.conname,
      'definition', pg_get_constraintdef(con.oid)
    ) ORDER BY con.conname), '[]'::json)
    FROM pg_constraint con WHERE con.confrelid = t.oid AND con.contype = 'f'
  ),
  'constraints', (
    SELECT coalesce(json_agg(json_build_object(
      'name', con.conname,
      'type', CASE con.contype WHEN 'c' THEN 'check' WHEN 'u' THEN 'unique' WHEN 'x' THEN 'exclusion' END,
      'definition', pg_get_constraintdef(con.oid)
    ) ORDER BY con.conname), '[]'::json)
    FROM pg_constraint con WHERE con.conrelid = t.oid AND con.contype IN ('c', 'u', 'x')
  ),
  'indexes', (
    SELECT coalesce(json_agg(json_build_object(
      'name', ic.relname,
      'unique', i.indisunique,
      'primary', i.indisprimary,
      'definition', pg_get_indexdef(i.indexrelid)
    ) ORDER BY ic.relname), '[]'::json)
    FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
    WHERE i.indrelid = t.oid
  ),
  'view_definition', CASE WHEN t.relkind IN ('v', 'm') THEN pg_get_viewdef(t.oid, true) END
)
FROM t`

const DATABASE_STATS = `SELECT json_build_object(
  'database', current_database(),
  'version', current_setting('server_version'),
  'size', pg_size_pretty(pg_database_size(current_database())),
  'size_bytes', pg_database_size(current_database()),
  'uptime', (now() - pg_postmaster_start_time())::text,
  'connections', (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()),
  'active_queries', (
    SELECT count(*) FROM pg_stat_activity
    WHERE datname = current_database() AND state = 'active' AND pid <> pg_backend_pid()
  ),
  'max_connections', current_setting('max_connections')::int,
  'tables', (
    SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\\_toast%'
  ),
  'cache_hit_ratio', round(d.blks_hit * 100.0 / nullif(d.blks_hit + d.blks_read, 0), 2),
  'commits', d.xact_commit,
  'rollbacks', d.xact_rollback,
  'deadlocks', d.deadlocks,
  'temp_files', d.temp_files
)
FROM pg_stat_database d
WHERE d.datname = current_database()`
