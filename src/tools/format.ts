// How a tool's answer is written into an MCP result. A set of rows can be
// rendered four ways (see `ResultFormat`); anything else — a table's
// description, a plan, an acknowledgement — is a JSON document in every format.
import type { QueryResult, ResultFormat } from "../domain.ts"
import type { ToolOutcome } from "./builtin.ts"

const TRUNCATED = "Result was cut at the row/size limit. Narrow the query or add LIMIT."

/** The text blocks of an MCP tool result. */
export function formatOutcome(outcome: ToolOutcome, format: ResultFormat): Array<string> {
  if (outcome.rows === undefined) return [JSON.stringify(outcome.data)]
  return formatRows(outcome.rows, format)
}

export function formatRows(result: QueryResult, format: ResultFormat): Array<string> {
  // A statement with no result set (an UPDATE without RETURNING) has nothing to tabulate.
  if (result.columns.length === 0) {
    const summary = `${result.command ?? "OK"}${result.row_count > 0 ? ` ${result.row_count}` : ""}`
    return format === "markdown" || format === "csv"
      ? [summary]
      : [JSON.stringify({ command: result.command, row_count: result.row_count })]
  }
  switch (format) {
    case "compact":
      return [JSON.stringify({
        columns: result.columns,
        rows: result.rows,
        row_count: result.row_count,
        ...(result.truncated ? { truncated: true, note: TRUNCATED } : {})
      })]
    case "objects": {
      const keys = uniqueKeys(result.columns)
      return [JSON.stringify({
        rows: result.rows.map((row) => Object.fromEntries(keys.map((key, index) => [key, row[index]]))),
        row_count: result.row_count,
        ...(result.truncated ? { truncated: true, note: TRUNCATED } : {})
      })]
    }
    case "markdown":
      return [markdown(result)]
    case "csv":
      // The note travels as its own block so the CSV stays parseable.
      return result.truncated ? [csv(result), TRUNCATED] : [csv(result)]
  }
}

/** Column names as object keys: a repeated name gets a numeric suffix rather than overwriting. */
function uniqueKeys(columns: ReadonlyArray<string>): Array<string> {
  const reserved = new Set(columns)
  const used = new Set<string>()
  const nextSuffix = new Map<string, number>()
  return columns.map((column) => {
    let key = column
    if (used.has(key)) {
      let suffix = nextSuffix.get(column) ?? 2
      do {
        key = `${column}_${suffix++}`
      } while (reserved.has(key) || used.has(key))
      nextSuffix.set(column, suffix)
    }
    used.add(key)
    return key
  })
}

const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return ""
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

function markdown(result: QueryResult): string {
  const escape = (text: string) => text.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\r?\n/g, "<br>")
  const line = (cells: ReadonlyArray<string>) => `| ${cells.join(" | ")} |`
  const rows = result.rows.map((row) => line(row.map((value) => (value === null ? "NULL" : escape(cellText(value))))))
  const count = `${result.row_count} row${result.row_count === 1 ? "" : "s"}`
  return [
    line(result.columns.map(escape)),
    line(result.columns.map(() => "---")),
    ...rows,
    "",
    result.truncated ? `${count} shown. ${TRUNCATED}` : count
  ].join("\n")
}

function csv(result: QueryResult): string {
  const field = (text: string) => (/[",\r\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text)
  return [
    result.columns.map(field).join(","),
    ...result.rows.map((row) => row.map((value) => field(cellText(value))).join(","))
  ].join("\n")
}
