import { describe, expect, test } from "bun:test"
import type { QueryResult } from "../src/domain.ts"
import { formatOutcome, formatRows } from "../src/tools/format.ts"

const result = (overrides: Partial<QueryResult> = {}): QueryResult => ({
  columns: ["id", "name"],
  rows: [[1, "Ada"], [2, null]],
  row_count: 2,
  truncated: false,
  command: "SELECT",
  duration_ms: 1,
  ...overrides
})

describe("compact", () => {
  test("a columns header and rows as arrays", () => {
    expect(formatRows(result(), "compact")).toEqual([
      "{\"columns\":[\"id\",\"name\"],\"rows\":[[1,\"Ada\"],[2,null]],\"row_count\":2}"
    ])
  })

  test("says when it was cut short", () => {
    const [text] = formatRows(result({ truncated: true }), "compact")
    expect(JSON.parse(text!)).toMatchObject({ truncated: true, note: expect.stringContaining("LIMIT") })
  })
})

describe("objects", () => {
  test("one object per row", () => {
    expect(JSON.parse(formatRows(result(), "objects")[0]!)).toEqual({
      rows: [{ id: 1, name: "Ada" }, { id: 2, name: null }],
      row_count: 2
    })
  })

  test("a repeated column name does not overwrite the first", () => {
    const [text] = formatRows(result({ columns: ["a", "a", "b", "a"], rows: [[1, 2, 3, 4]], row_count: 1 }), "objects")
    expect(JSON.parse(text!).rows).toEqual([{ a: 1, a_2: 2, b: 3, a_3: 4 }])
  })

  test("generated suffixes do not overwrite named columns or other duplicates", () => {
    const [text] = formatRows(result({
      columns: ["x", "x", "x_2", "x_3", "x", "x_2", "x_2_2"],
      rows: [[1, 2, 3, 4, 5, 6, 7]],
      row_count: 1
    }), "objects")
    expect(JSON.parse(text!).rows).toEqual([{ x: 1, x_4: 2, x_2: 3, x_3: 4, x_5: 5, x_2_3: 6, x_2_2: 7 }])
  })
})

describe("markdown", () => {
  test("a table with a row count", () => {
    expect(formatRows(result(), "markdown")).toEqual([
      "| id | name |\n| --- | --- |\n| 1 | Ada |\n| 2 | NULL |\n\n2 rows"
    ])
  })

  test("escapes what would break the table", () => {
    const [text] = formatRows(
      result({ columns: ["a|b"], rows: [["x | y"], ["line1\nline2"], [{ k: [1, 2] }], ["back\\slash"]], row_count: 4 }),
      "markdown"
    )
    expect(text!.split("\n").slice(0, 6)).toEqual([
      "| a\\|b |",
      "| --- |",
      "| x \\| y |",
      "| line1<br>line2 |",
      "| {\"k\":[1,2]} |",
      "| back\\\\slash |"
    ])
  })

  test("singular, and the truncation note", () => {
    expect(formatRows(result({ rows: [[1, "a"]], row_count: 1 }), "markdown")[0]).toEndWith("\n\n1 row")
    expect(formatRows(result({ truncated: true }), "markdown")[0]).toContain("2 rows shown. Result was cut")
  })
})

describe("csv", () => {
  test("a header row, then the data", () => {
    expect(formatRows(result(), "csv")).toEqual(["id,name\n1,Ada\n2,"])
  })

  test("quotes fields that need it", () => {
    const [text] = formatRows(
      result({ columns: ["a,b", "c"], rows: [["say \"hi\"", "x,y"], ["two\nlines", { j: 1 }], [true, 1.5]], row_count: 3 }),
      "csv"
    )
    expect(text).toBe("\"a,b\",c\n\"say \"\"hi\"\"\",\"x,y\"\n\"two\nlines\",\"{\"\"j\"\":1}\"\ntrue,1.5")
  })

  test("the truncation note is a separate block, so the CSV stays parseable", () => {
    const blocks = formatRows(result({ truncated: true }), "csv")
    expect(blocks.length).toBe(2)
    expect(blocks[0]).toBe("id,name\n1,Ada\n2,")
    expect(blocks[1]).toContain("cut at the row/size limit")
  })
})

describe("statements without a result set", () => {
  const update = result({ columns: [], rows: [], row_count: 3, command: "UPDATE" })

  test("JSON formats report the command", () => {
    expect(JSON.parse(formatRows(update, "compact")[0]!)).toEqual({ command: "UPDATE", row_count: 3 })
    expect(JSON.parse(formatRows(update, "objects")[0]!)).toEqual({ command: "UPDATE", row_count: 3 })
  })

  test("text formats print the command tag", () => {
    expect(formatRows(update, "markdown")).toEqual(["UPDATE 3"])
    expect(formatRows(update, "csv")).toEqual(["UPDATE 3"])
    expect(formatRows(result({ columns: [], rows: [], row_count: 0, command: "CREATE" }), "csv")).toEqual(["CREATE"])
  })

  test("zero rows of a real result set is still a table", () => {
    const empty = result({ rows: [], row_count: 0 })
    expect(formatRows(empty, "markdown")).toEqual(["| id | name |\n| --- | --- |\n\n0 rows"])
    expect(formatRows(empty, "csv")).toEqual(["id,name"])
  })
})

describe("formatOutcome", () => {
  test("an answer that is not rows is JSON in every format", () => {
    const outcome = { data: { ok: true, dropped: "public.t" }, sql: null, row_count: null }
    for (const format of ["compact", "objects", "markdown", "csv"] as const) {
      expect(formatOutcome(outcome, format)).toEqual(["{\"ok\":true,\"dropped\":\"public.t\"}"])
    }
  })

  test("an answer with rows is written from the rows", () => {
    const outcome = { data: { tables: [] }, rows: result(), sql: null, row_count: 2 }
    expect(formatOutcome(outcome, "csv")).toEqual(["id,name\n1,Ada\n2,"])
  })
})
