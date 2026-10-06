import { describe, expect, test } from "bun:test"
import type { ToolParam } from "../src/domain.ts"
import { compileTemplate, deriveParams, matchesType, paramsJsonSchema, validateTemplate } from "../src/sql/template.ts"

const params: Array<ToolParam> = [
  { name: "status", type: "string" },
  { name: "limit", type: "int", default: 10 }
]
const sql = "SELECT * FROM orders WHERE status = :status LIMIT :limit"

describe("matchesType", () => {
  test("is strict about each type", () => {
    expect(matchesType("string", "a")).toBe(true)
    expect(matchesType("string", 1)).toBe(false)
    expect(matchesType("int", 3)).toBe(true)
    expect(matchesType("int", 3.5)).toBe(false)
    expect(matchesType("int", "3")).toBe(false)
    expect(matchesType("int", true)).toBe(false)
    expect(matchesType("float", 3.5)).toBe(true)
    expect(matchesType("float", 3)).toBe(true)
    expect(matchesType("float", Number.NaN)).toBe(false)
    expect(matchesType("bool", false)).toBe(true)
    expect(matchesType("bool", 0)).toBe(false)
  })
})

describe("validateTemplate", () => {
  test("accepts a matching template", () => {
    expect(validateTemplate(sql, params)).toBeNull()
    expect(validateTemplate("SELECT 1", [])).toBeNull()
  })

  test("rejects empty and comment-only SQL", () => {
    expect(validateTemplate("   ", [])).toBe("SQL is required")
    expect(validateTemplate("-- nothing", [])).toBe("SQL is required")
  })

  test("rejects batches", () => {
    expect(validateTemplate("SELECT 1; DROP TABLE x", [])).toBe("Only a single SQL statement is allowed")
  })

  test("placeholders and params must match both ways", () => {
    expect(validateTemplate("SELECT :a", [])).toBe("Placeholder \":a\" is not a declared param")
    expect(validateTemplate("SELECT 1", [{ name: "a", type: "int" }])).toBe(
      "Declared param \"a\" does not appear in the SQL"
    )
  })

  test("a placeholder inside a string does not count as used", () => {
    expect(validateTemplate("SELECT ':a'", [{ name: "a", type: "int" }])).toBe(
      "Declared param \"a\" does not appear in the SQL"
    )
  })

  test("rejects duplicate and malformed param names", () => {
    expect(validateTemplate("SELECT :a", [{ name: "a", type: "int" }, { name: "a", type: "int" }])).toBe(
      "Param \"a\" is declared twice"
    )
    expect(validateTemplate("SELECT 1", [{ name: "1a", type: "int" }])).toBe("\"1a\" is not a valid param name")
  })

  test("a default must match the declared type", () => {
    expect(validateTemplate("SELECT :a", [{ name: "a", type: "int", default: "x" }])).toBe(
      "Param \"a\" default must be an integer (got \"x\")"
    )
    expect(validateTemplate("SELECT :a", [{ name: "a", type: "bool", default: false }])).toBeNull()
  })
})

describe("compileTemplate", () => {
  test("binds values in placeholder order", () => {
    expect(compileTemplate(sql, params, { status: "paid", limit: 3 })).toEqual({
      ok: true,
      sql: "SELECT * FROM orders WHERE status = $1 LIMIT $2",
      values: ["paid", 3]
    })
  })

  test("binds the default for an omitted optional param", () => {
    expect(compileTemplate(sql, params, { status: "paid" })).toMatchObject({ ok: true, values: ["paid", 10] })
    expect(compileTemplate(sql, params, { status: "paid", limit: null })).toMatchObject({ ok: true, values: ["paid", 10] })
  })

  test("a falsy default is still a default", () => {
    const withFalsy: Array<ToolParam> = [{ name: "flag", type: "bool", default: false }, { name: "n", type: "int", default: 0 }]
    expect(compileTemplate("SELECT :flag, :n", withFalsy, {})).toMatchObject({ ok: true, values: [false, 0] })
  })

  test("a repeated placeholder binds once", () => {
    expect(compileTemplate("SELECT :a, :a", [{ name: "a", type: "int" }], { a: 1 })).toEqual({
      ok: true,
      sql: "SELECT $1, $1",
      values: [1]
    })
  })

  test("rejects a missing required param", () => {
    expect(compileTemplate(sql, params, {})).toEqual({ ok: false, error: "Missing param \"status\" (expected a string)" })
  })

  test("rejects an unknown param", () => {
    expect(compileTemplate(sql, params, { status: "x", nope: 1 })).toEqual({ ok: false, error: "Unknown param \"nope\"" })
  })

  test("rejects a wrongly typed value — no coercion", () => {
    expect(compileTemplate(sql, params, { status: "x", limit: "5" })).toEqual({
      ok: false,
      error: "Param \"limit\" must be an integer"
    })
    expect(compileTemplate(sql, params, { status: 5 })).toEqual({ ok: false, error: "Param \"status\" must be a string" })
  })

  test("a value is never spliced into the SQL text", () => {
    const hostile = "x'; DROP TABLE orders; --"
    const compiled = compileTemplate(sql, params, { status: hostile })
    expect(compiled).toMatchObject({ ok: true, sql: "SELECT * FROM orders WHERE status = $1 LIMIT $2" })
    if (compiled.ok) expect(compiled.values[0]).toBe(hostile)
  })

  test("fails loud when stored SQL drifted from its params", () => {
    expect(compileTemplate("SELECT :a, :b", [{ name: "a", type: "int" }], { a: 1 })).toEqual({
      ok: false,
      error: "Placeholder \":b\" is not a declared param"
    })
  })
})

describe("deriveParams", () => {
  test("every placeholder becomes a string param", () => {
    expect(deriveParams("SELECT :a, :b")).toEqual([{ name: "a", type: "string" }, { name: "b", type: "string" }])
  })

  test("keeps existing declarations for names that survive", () => {
    expect(deriveParams("SELECT :limit, :fresh", params)).toEqual([
      { name: "limit", type: "int", default: 10 },
      { name: "fresh", type: "string" }
    ])
  })
})

describe("paramsJsonSchema", () => {
  test("required params are the ones without a default", () => {
    expect(paramsJsonSchema([...params, { name: "ratio", type: "float", description: "0..1" }])).toEqual({
      type: "object",
      properties: {
        status: { type: "string" },
        limit: { type: "integer", default: 10 },
        ratio: { type: "number", description: "0..1" }
      },
      required: ["status", "ratio"],
      additionalProperties: false
    })
  })

  test("no params is an empty object schema", () => {
    expect(paramsJsonSchema([])).toEqual({ type: "object", properties: {}, additionalProperties: false })
  })
})
