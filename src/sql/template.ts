// Custom-tool templates: SQL with `:name` placeholders and typed params.
//
// A custom tool is a pure function of SQL + typed params. Authorship is the
// security boundary: only an admin writes the SQL, a caller only ever supplies
// values, and values travel as bind parameters — never as SQL text.
import type { ParamType, ParamValue, ToolParam } from "../domain.ts"
import { PARAM_NAME_RE } from "../domain.ts"
import { hasMultipleStatements, isBlank, placeholderNames, toPositional } from "./sqltext.ts"

export const MAX_SQL_LENGTH = 100_000
export const MAX_PARAMS = 50

const TYPE_LABELS: Record<ParamType, string> = {
  string: "a string",
  int: "an integer",
  float: "a number",
  bool: "a boolean"
}

/** Strict runtime type check shared by save time (defaults) and call time (values). */
export function matchesType(type: ParamType, value: unknown): value is ParamValue {
  switch (type) {
    case "string":
      return typeof value === "string"
    case "bool":
      return typeof value === "boolean"
    case "int":
      return typeof value === "number" && Number.isSafeInteger(value)
    case "float":
      return typeof value === "number" && Number.isFinite(value)
  }
}

/**
 * Save-time checks: placeholders and declared params must match exactly.
 * Returns an error message, or null when the template is sound.
 */
export function validateTemplate(sql: string, params: ReadonlyArray<ToolParam>): string | null {
  if (isBlank(sql)) return "SQL is required"
  if (sql.length > MAX_SQL_LENGTH) return `SQL too long (max ${MAX_SQL_LENGTH} characters)`
  if (hasMultipleStatements(sql)) return "Only a single SQL statement is allowed"
  if (params.length > MAX_PARAMS) return `Too many params (max ${MAX_PARAMS})`

  const declared: Array<string> = []
  for (const param of params) {
    if (!PARAM_NAME_RE.test(param.name)) return `"${param.name}" is not a valid param name`
    if (declared.includes(param.name)) return `Param "${param.name}" is declared twice`
    // A default makes the param optional — it must match the declared type now,
    // not surprise a caller who omitted the param later.
    if (param.default !== undefined && !matchesType(param.type, param.default)) {
      return `Param "${param.name}" default must be ${TYPE_LABELS[param.type]} (got ${JSON.stringify(param.default)})`
    }
    declared.push(param.name)
  }

  const placeholders = placeholderNames(sql)
  for (const name of placeholders) {
    if (!declared.includes(name)) return `Placeholder ":${name}" is not a declared param`
  }
  for (const name of declared) {
    // An unused param is almost certainly a typo the author wants to hear about.
    if (!placeholders.includes(name)) return `Declared param "${name}" does not appear in the SQL`
  }
  return null
}

/**
 * Derive params from the SQL alone: every `:name` becomes a param, keeping the
 * type/default/description of any existing declaration with that name.
 */
export function deriveParams(sql: string, existing: ReadonlyArray<ToolParam> = []): Array<ToolParam> {
  return placeholderNames(sql).map((name) => existing.find((p) => p.name === name) ?? { name, type: "string" })
}

export type Compiled =
  | { readonly ok: true; readonly sql: string; readonly values: Array<ParamValue> }
  | { readonly ok: false; readonly error: string }

/**
 * Resolve a template against caller arguments: type-check every value, bind
 * defaults for omitted optional params, and rewrite `:name` to `$N`.
 */
export function compileTemplate(
  sql: string,
  params: ReadonlyArray<ToolParam>,
  args: Readonly<Record<string, unknown>>
): Compiled {
  const declared = new Map(params.map((p) => [p.name, p]))
  for (const name of Object.keys(args)) {
    if (!declared.has(name)) return { ok: false, error: `Unknown param "${name}"` }
  }

  const bound = new Map<string, ParamValue>()
  for (const param of params) {
    const supplied = args[param.name]
    if (supplied === undefined || supplied === null) {
      if (param.default === undefined) {
        return { ok: false, error: `Missing param "${param.name}" (expected ${TYPE_LABELS[param.type]})` }
      }
      bound.set(param.name, param.default)
      continue
    }
    if (!matchesType(param.type, supplied)) {
      return { ok: false, error: `Param "${param.name}" must be ${TYPE_LABELS[param.type]}` }
    }
    bound.set(param.name, supplied)
  }

  const positional = toPositional(sql)
  const values: Array<ParamValue> = []
  for (const name of positional.names) {
    const value = bound.get(name)
    // A stored row whose SQL drifted from its params must fail loud, never bind nothing.
    if (value === undefined) return { ok: false, error: `Placeholder ":${name}" is not a declared param` }
    values.push(value)
  }
  return { ok: true, sql: positional.sql, values }
}

/** The JSON Schema an MCP client sees for a custom tool's arguments. */
export function paramsJsonSchema(params: ReadonlyArray<ToolParam>): Record<string, unknown> {
  const jsonType: Record<ParamType, string> = { string: "string", int: "integer", float: "number", bool: "boolean" }
  const properties: Record<string, unknown> = {}
  const required: Array<string> = []
  for (const param of params) {
    const property: Record<string, unknown> = { type: jsonType[param.type] }
    if (param.description) property.description = param.description
    if (param.default !== undefined) property.default = param.default
    else required.push(param.name)
    properties[param.name] = property
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false
  }
}
