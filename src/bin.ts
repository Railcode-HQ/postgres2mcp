#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import { Command } from "effect/cli"
import { commands } from "./commands.ts"
import { VERSION } from "./version.ts"

commands.pipe(
  Command.run({ version: VERSION }),
  // A command that could not do its job says why in one line and exits 1 —
  // no stack trace for "no database was given".
  Effect.catchTag("UsageError", (error) =>
    Console.error(`error: ${error.message}`).pipe(
      Effect.andThen(Effect.sync(() => {
        process.exitCode = 1
      }))
    )),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
)
