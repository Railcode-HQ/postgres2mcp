// Creating, changing and deleting custom tools. The admin API and the
// authoring tools offered over MCP both go through here, so a tool is checked
// the same way whoever writes it.
import { Effect } from "effect"
import type { CustomTool, ToolParam } from "../domain.ts"
import { TOOL_NAME_RE } from "../domain.ts"
import { BadRequest, NotFound } from "../errors.ts"
import type { CustomToolRow, GroupRow, Store } from "../services/Store.ts"
import { deriveParams, validateTemplate } from "../sql/template.ts"
import { isBuiltinGroup } from "./builtin.ts"

export interface CustomToolInput {
  readonly name: string
  readonly sql: string
  readonly description?: string | undefined
  /** Omitted params are derived from the SQL: every :name becomes a string param. */
  readonly params?: ReadonlyArray<ToolParam> | undefined
  readonly allow_writes?: boolean | undefined
  /** Custom groups to add the tool to. */
  readonly groups?: ReadonlyArray<string> | undefined
}

export interface CustomToolPatch {
  readonly sql?: string | undefined
  readonly description?: string | undefined
  readonly params?: ReadonlyArray<ToolParam> | undefined
  readonly allow_writes?: boolean | undefined
  /** When given, the tool ends up in exactly these custom groups. */
  readonly groups?: ReadonlyArray<string> | undefined
}

export interface CustomToolAdmin {
  readonly list: Effect.Effect<Array<CustomTool>>
  get(name: string): Effect.Effect<CustomTool, NotFound>
  create(input: CustomToolInput): Effect.Effect<CustomTool, BadRequest>
  update(name: string, patch: CustomToolPatch): Effect.Effect<CustomTool, NotFound | BadRequest>
  remove(name: string): Effect.Effect<void, NotFound>
}

export function makeCustomToolAdmin(
  store: Store["Service"],
  /** Names a custom tool may not take (the built-in tools). */
  isReserved: (name: string) => boolean
): CustomToolAdmin {
  const missing = (name: string) => new NotFound({ message: `No custom tool "${name}"` })

  /** A stored tool plus the custom groups that list it. */
  const withGroups = (row: CustomToolRow, groups: ReadonlyArray<GroupRow>): CustomTool => ({
    ...row,
    groups: groups.filter((group) => group.tools.includes(row.name)).map((group) => group.id)
  })

  const present = (row: CustomToolRow) => Effect.map(store.listGroups, (groups) => withGroups(row, groups))

  /** Only custom groups can be chosen for a tool; built-in groups are fixed. */
  const checkGroups = Effect.fn(function*(ids: ReadonlyArray<string>) {
    const known = new Set((yield* store.listGroups).map((group) => group.id))
    for (const id of ids) {
      if (isBuiltinGroup(id)) {
        return yield* new BadRequest({
          message: `"${id}" is a built-in group. Every custom tool is already in "custom" and "all".`
        })
      }
      if (!known.has(id)) return yield* new BadRequest({ message: `Unknown group "${id}"` })
    }
  })

  /** Make the tool a member of exactly the listed custom groups. */
  const setGroups = Effect.fn(function*(name: string, ids: ReadonlyArray<string>) {
    const wanted = new Set(ids)
    for (const group of yield* store.listGroups) {
      const member = group.tools.includes(name)
      if (wanted.has(group.id) && !member) {
        yield* store.updateGroup(group.id, { tools: [...group.tools, name] })
      } else if (!wanted.has(group.id) && member) {
        yield* store.updateGroup(group.id, { tools: group.tools.filter((tool) => tool !== name) })
      }
    }
  })

  return {
    list: Effect.gen(function*() {
      const groups = yield* store.listGroups
      return (yield* store.listCustomTools).map((row) => withGroups(row, groups))
    }),

    get: (name) =>
      Effect.flatMap(store.getCustomTool(name), (row) => row === null ? Effect.fail(missing(name)) : present(row)),

    create: Effect.fn("CustomTools.create")(function*(input: CustomToolInput) {
      if (!TOOL_NAME_RE.test(input.name)) {
        return yield* new BadRequest({
          message: "Tool name must start with a letter and use lowercase letters, digits or _ (max 64)"
        })
      }
      if (isReserved(input.name)) {
        return yield* new BadRequest({ message: `"${input.name}" is the name of a built-in tool` })
      }
      if ((yield* store.getCustomTool(input.name)) !== null) {
        return yield* new BadRequest({ message: `A custom tool named "${input.name}" already exists` })
      }
      const params = input.params ?? deriveParams(input.sql)
      const invalid = validateTemplate(input.sql, params)
      if (invalid !== null) return yield* new BadRequest({ message: invalid })
      yield* checkGroups(input.groups ?? [])
      const created = yield* store.createCustomTool({
        name: input.name,
        description: input.description?.trim() ?? "",
        sql: input.sql,
        params,
        allow_writes: input.allow_writes ?? false
      })
      yield* setGroups(created.name, input.groups ?? [])
      return yield* present(created)
    }),

    update: Effect.fn("CustomTools.update")(function*(name: string, patch: CustomToolPatch) {
      const current = yield* store.getCustomTool(name)
      if (current === null) return yield* missing(name)
      const sql = patch.sql ?? current.sql
      // New SQL without new params: keep what was declared for names that survive.
      const params = patch.params ?? (patch.sql === undefined ? current.params : deriveParams(sql, current.params))
      const invalid = validateTemplate(sql, params)
      if (invalid !== null) return yield* new BadRequest({ message: invalid })
      if (patch.groups !== undefined) yield* checkGroups(patch.groups)
      const updated = yield* store.updateCustomTool(name, {
        sql,
        params,
        description: patch.description?.trim(),
        allow_writes: patch.allow_writes
      })
      if (updated === null) return yield* missing(name)
      if (patch.groups !== undefined) yield* setGroups(updated.name, patch.groups)
      return yield* present(updated)
    }),

    remove: Effect.fn("CustomTools.remove")(function*(name: string) {
      if (!(yield* store.deleteCustomTool(name))) return yield* missing(name)
      // Fail closed: a tool recreated under the same name must not inherit
      // grants that named the old one.
      for (const key of yield* store.listKeys) {
        if (key.tools.includes(name)) {
          yield* store.updateKey(key.id, { tools: key.tools.filter((tool) => tool !== name) })
        }
      }
      yield* setGroups(name, [])
    })
  }
}
