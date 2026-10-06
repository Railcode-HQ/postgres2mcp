import { describe, expect, test } from "bun:test"
import {
  findPlaceholders,
  hasMultipleStatements,
  isBlank,
  placeholderNames,
  qualified,
  quoteIdent,
  segments,
  toPositional
} from "../src/sql/sqltext.ts"
import { segments as webSegments } from "../web/src/lib/sqlTemplate.ts"

const kinds = (sql: string) => segments(sql).map((seg) => `${seg.kind}:${sql.slice(seg.start, seg.end)}`)

describe("segments", () => {
  test("splits strings, identifiers and comments out of code", () => {
    expect(kinds(`SELECT 'a' FROM "t" -- c\nWHERE /* b */ x`)).toEqual([
      "code:SELECT ",
      "string:'a'",
      "code: FROM ",
      "ident:\"t\"",
      "code: ",
      "lineComment:-- c\n",
      "code:WHERE ",
      "blockComment:/* b */",
      "code: x"
    ])
  })

  test("doubled quotes do not end a string or identifier", () => {
    expect(kinds(`'it''s' "a""b"`)).toEqual(["string:'it''s'", "code: ", "ident:\"a\"\"b\""])
  })

  test("E-strings honour backslash escapes", () => {
    expect(kinds(`E'a\\'b' :x`)).toEqual(["code:E", "string:'a\\'b'", "code: :x"])
    // A plain string does not: the backslash is literal and the quote closes it.
    expect(kinds(`'a\\' :x`)).toEqual(["string:'a\\'", "code: :x"])
  })

  test("dollar-quoted bodies are opaque, tagged or not", () => {
    expect(kinds("SELECT $$ :a; $$, $fn$ :b $fn$")).toEqual([
      "code:SELECT ",
      "dollar:$$ :a; $$",
      "code:, ",
      "dollar:$fn$ :b $fn$"
    ])
  })

  test("$N placeholders stay in code", () => {
    expect(kinds("SELECT $1, $2")).toEqual(["code:SELECT $1, $2"])
  })

  test("nested block comments", () => {
    expect(kinds("/* a /* b */ c */ x")).toEqual(["blockComment:/* a /* b */ c */", "code: x"])
  })

  test("line comments end at CR, LF or CRLF in both lexers", () => {
    for (const newline of ["\r", "\n", "\r\n"]) {
      const sql = `-- comment${newline}COPY (SELECT 1) TO STDOUT`
      expect(segments(sql)).toEqual(webSegments(sql))
      expect(segments(sql).filter((segment) => segment.kind === "code").map((segment) => sql.slice(segment.start, segment.end)).join("").trim())
        .toBe("COPY (SELECT 1) TO STDOUT")
      expect(placeholderNames(`-- :hidden${newline}SELECT :visible`)).toEqual(["visible"])
    }
  })

  test("unterminated spans run to the end", () => {
    expect(kinds("SELECT 'abc")).toEqual(["code:SELECT ", "string:'abc"])
    expect(kinds("SELECT /* abc")).toEqual(["code:SELECT ", "blockComment:/* abc"])
  })
})

describe("placeholders", () => {
  test("finds :name in code only", () => {
    const sql = `SELECT :a, ':b', ":c", $$ :d $$ -- :e\n/* :f */ FROM t WHERE x = :g AND y = :a`
    expect(placeholderNames(sql)).toEqual(["a", "g"])
  })

  test("skips :: casts", () => {
    expect(placeholderNames("SELECT x::int, :y::text, a::b")).toEqual(["y"])
  })

  test("matches after punctuation and operators", () => {
    expect(placeholderNames("WHERE a=:a AND b IN (:b,:c) AND d>:d")).toEqual(["a", "b", "c", "d"])
  })

  test("does not match inside words or array slices", () => {
    expect(placeholderNames("SELECT arr[1:2], a:b")).toEqual([])
  })

  test("reports absolute offsets", () => {
    const sql = "SELECT ':x', :y"
    const [hit] = findPlaceholders(sql)
    expect(sql.slice(hit!.start, hit!.end)).toBe(":y")
  })

  test("toPositional numbers by first occurrence and reuses repeats", () => {
    expect(toPositional("SELECT :b, :a, :b, ':a'")).toEqual({ sql: "SELECT $1, $2, $1, ':a'", names: ["b", "a"] })
  })

  test("toPositional leaves SQL without placeholders untouched", () => {
    const sql = "SELECT 1::int -- :nope"
    expect(toPositional(sql)).toEqual({ sql, names: [] })
  })
})

describe("statements", () => {
  test("single statements, with or without a trailing semicolon", () => {
    expect(hasMultipleStatements("SELECT 1")).toBe(false)
    expect(hasMultipleStatements("SELECT 1;")).toBe(false)
    expect(hasMultipleStatements("SELECT 1;  \n -- done\n")).toBe(false)
    expect(hasMultipleStatements("SELECT ';' ; /* ; */")).toBe(false)
    expect(hasMultipleStatements("DO $$ BEGIN PERFORM 1; PERFORM 2; END $$")).toBe(false)
  })

  test("batches are detected", () => {
    expect(hasMultipleStatements("SELECT 1; SELECT 2")).toBe(true)
    expect(hasMultipleStatements("SELECT 1; 'x'")).toBe(true)
    expect(hasMultipleStatements("COMMIT; DROP TABLE t")).toBe(true)
    expect(hasMultipleStatements("SELECT 1;;SELECT 2")).toBe(true)
  })

  test("blank detection", () => {
    expect(isBlank("")).toBe(true)
    expect(isBlank("  \n ; ")).toBe(true)
    expect(isBlank("-- just a comment\n/* and another */")).toBe(true)
    expect(isBlank("SELECT 1")).toBe(false)
    expect(isBlank("'x'")).toBe(false)
  })
})

describe("identifiers", () => {
  test("quoteIdent doubles embedded quotes", () => {
    expect(quoteIdent("orders")).toBe("\"orders\"")
    expect(quoteIdent("we\"ird")).toBe("\"we\"\"ird\"")
    expect(qualified("public", "t; DROP TABLE x")).toBe("\"public\".\"t; DROP TABLE x\"")
  })
})
