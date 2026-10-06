import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { AppConfig, DEFAULTS } from "../src/services/AppConfig.ts"
import { Auth } from "../src/services/Auth.ts"
import { Store } from "../src/services/Store.ts"

const config = Layer.succeed(AppConfig, {
  ...DEFAULTS,
  databaseUrl: "postgres://unused",
  dataDir: ":memory:",
  bootstrapAdmin: null,
  setupToken: "test-code",
  publicUrl: null,
  webDir: null
})

const run = (effect: Effect.Effect<void, never, Auth | TestClock.TestClock>) => Effect.runPromise(effect.pipe(
  Effect.provide(Auth.layer.pipe(Layer.provide(Store.layer), Layer.provide(config))),
  Effect.provide(TestClock.layer())
))

test("the global login budget applies across usernames and recovers after its window", async () => {
  await run(Effect.gen(function*() {
    const auth = yield* Auth
    for (let i = 0; i < 60; i++) {
      const result = yield* Effect.result(auth.login(`unknown-${i}`, "incorrect", null))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure._tag).toBe("Unauthorized")
    }
    const blocked = yield* Effect.result(auth.login("another-name", "incorrect", null))
    expect(blocked._tag).toBe("Failure")
    if (blocked._tag === "Failure") expect(blocked.failure._tag).toBe("TooManyAttempts")

    yield* TestClock.adjust(60_000)
    const recovered = yield* Effect.result(auth.login("another-name", "incorrect", null))
    expect(recovered._tag).toBe("Failure")
    if (recovered._tag === "Failure") expect(recovered.failure._tag).toBe("Unauthorized")
  }))
})

test("expired account failures are cleared while other usernames sign in", async () => {
  await run(Effect.gen(function*() {
    const auth = yield* Auth
    for (let i = 0; i < 5; i++) yield* Effect.result(auth.login("old-name", "incorrect", null))
    const blocked = yield* Effect.result(auth.login("old-name", "incorrect", null))
    if (blocked._tag === "Failure") expect(blocked.failure._tag).toBe("TooManyAttempts")
    else throw new Error("Expected a throttled login")

    yield* TestClock.adjust(5 * 60_000)
    yield* Effect.result(auth.login("new-name", "incorrect", null))
    const recovered = yield* Effect.result(auth.login("old-name", "incorrect", null))
    expect(recovered._tag).toBe("Failure")
    if (recovered._tag === "Failure") expect(recovered.failure._tag).toBe("Unauthorized")
  }))
})
