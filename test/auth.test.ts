// Accounts: first-run setup, signing in and out, password changes, and the
// operator's way back in. Starts a server with no account at all.
import { Database } from "bun:sqlite"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ADMIN_PASSWORD, seedDatabase, startServer, type TestServer } from "./harness.ts"

let server: TestServer
let session = ""

const SETUP_CODE = "test-setup-code"
const NO_ACCOUNT = { P2M_ADMIN_USERNAME: "", P2M_ADMIN_PASSWORD: "", P2M_SETUP_TOKEN: SETUP_CODE }

const post = (path: string, body: Record<string, unknown>, token = "") =>
  server.api("POST", path, path === "/auth/setup" ? { ...body, setup_code: SETUP_CODE } : body, token)
const login = (username: string, password: string) => post("/auth/login", { username, password })

beforeAll(async () => {
  await seedDatabase()
  server = await startServer(NO_ACCOUNT)
})

afterAll(async () => {
  await server.stop()
})

describe("before setup", () => {
  test("the server says setup is required, and nothing else works", async () => {
    expect((await server.api("GET", "/auth/state", undefined, "")).body.setup_required).toBe(true)
    expect((await server.api("GET", "/status", undefined, "")).status).toBe(401)
    expect((await login("admin", "whatever-password")).status).toBe(401)
  })
})

describe("setup", () => {
  test("rejects a bad username or a short password, and creates nothing", async () => {
    expect((await post("/auth/setup", { username: "has space", password: "long-enough-1" })).body.message)
      .toContain("Username must be")
    expect((await post("/auth/setup", { username: "", password: "long-enough-1" })).status).toBe(400)
    expect((await post("/auth/setup", { username: "admin", password: "short" })).body.message)
      .toBe("Password must be at least 8 characters")
    expect((await server.api("GET", "/auth/state", undefined, "")).body.setup_required).toBe(true)
  })

  test("the first account signs straight in", async () => {
    const created = await post("/auth/setup", { username: "Admin", password: "first-password" })
    expect(created.status).toBe(200)
    expect(created.body.user).toMatchObject({ username: "Admin", id: expect.stringMatching(/^user_/) })
    expect(created.body.token).toMatch(/^p2ms_/)
    session = created.body.token
    expect((await server.api("GET", "/auth/me", undefined, session)).body).toEqual({ username: "Admin" })
    expect((await server.api("GET", "/status", undefined, session)).status).toBe(200)
    expect((await server.api("GET", "/auth/state", undefined, "")).body.setup_required).toBe(false)
  })

  test("works exactly once", async () => {
    const again = await post("/auth/setup", { username: "intruder", password: "another-password" })
    expect(again.status).toBe(400)
    expect(again.body.message).toContain("already complete")
    expect((await login("intruder", "another-password")).status).toBe(401)
  })
})

describe("signing in", () => {
  test("with the right password, case-insensitively on the username", async () => {
    const ok = await login("admin", "first-password")
    expect(ok.status).toBe(200)
    expect(ok.body.user.username).toBe("Admin")
    expect(ok.body.token).not.toBe(session)
    expect((await server.api("GET", "/status", undefined, ok.body.token)).status).toBe(200)
  })

  test("a wrong password and an unknown user get the same answer", async () => {
    const wrong = await login("admin", "not-the-password")
    const unknown = await login("nobody", "not-the-password")
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(wrong.body.message).toBe(unknown.body.message)
  })

  test("repeated failures are throttled per username", async () => {
    for (let attempt = 0; attempt < 5; attempt++) expect((await login("ghost", "guess-number-x")).status).toBe(401)
    const blocked = await login("ghost", "guess-number-x")
    expect(blocked.status).toBe(429)
    expect(blocked.body.message).toContain("Too many failed sign-ins")
    // Someone else's failures do not lock the real account out.
    expect((await login("admin", "first-password")).status).toBe(200)
  })

  test("concurrent guesses share the normalized username's attempt budget", async () => {
    const isolated = await startServer()
    try {
      const attempts = await Promise.all(Array.from({ length: 12 }, (_, index) =>
        isolated.api("POST", "/auth/login", {
          username: ["admin", "ADMIN", " Admin "][index % 3],
          password: "incorrect-password"
        }, "")))
      expect(attempts.filter((response) => response.status === 401)).toHaveLength(5)
      expect(attempts.filter((response) => response.status === 429)).toHaveLength(7)
      // Even the correct password is refused until the failure window ends.
      const blocked = await isolated.api("POST", "/auth/login", { username: "admin", password: ADMIN_PASSWORD }, "")
      expect(blocked.status).toBe(429)
      expect(blocked.body.message).toContain("Too many failed sign-ins")
      expect((await isolated.api("POST", "/auth/login", { username: "someone-else", password: "incorrect" }, "")).status).toBe(401)
    } finally {
      await isolated.stop()
    }
  })

  test("neither passwords nor session tokens are stored in the clear", async () => {
    const db = new Database(join(server.dataDir, "postgres2mcp.db"), { readonly: true })
    const user = db.query("SELECT password_hash FROM users").get() as { password_hash: string }
    expect(user.password_hash).toStartWith("$argon2")
    const bytes = readFileSync(join(server.dataDir, "postgres2mcp.db"))
    const wal = existsSync(join(server.dataDir, "postgres2mcp.db-wal"))
      ? readFileSync(join(server.dataDir, "postgres2mcp.db-wal"))
      : Buffer.alloc(0)
    for (const secret of ["first-password", session]) {
      expect(bytes.includes(Buffer.from(secret))).toBe(false)
      expect(wal.includes(Buffer.from(secret))).toBe(false)
    }
    db.close()
  })

  test("rotating usernames cannot create unlimited concurrent password checks", async () => {
    const isolated = await startServer()
    try {
      const attempts = await Promise.all(Array.from({ length: 32 }, (_, i) =>
        isolated.api("POST", "/auth/login", { username: `unknown-${i}`, password: "incorrect" }, "")))
      expect(attempts.some((response) => response.status === 429)).toBe(true)
      expect(attempts.every((response) => response.status === 401 || response.status === 429)).toBe(true)
      expect((await isolated.api("POST", "/auth/login", { username: "admin", password: ADMIN_PASSWORD }, "")).status).toBe(200)
    } finally {
      await isolated.stop()
    }
  })

  test("oversized credentials are rejected before password verification", async () => {
    expect((await login("x".repeat(10000), "incorrect")).status).toBe(401)
    expect((await login("admin", "x".repeat(4097))).status).toBe(401)
    expect((await login("admin", "first-password")).status).toBe(200)
  })

  test("a session token is not an API key", async () => {
    const response = await server.rpc(session, { jsonrpc: "2.0", id: 1, method: "tools/list" })
    expect(response.status).toBe(401)
  })
})

describe("signing out", () => {
  test("ends that session and no other", async () => {
    const other = (await login("admin", "first-password")).body.token
    expect((await post("/auth/logout", {}, other)).status).toBe(204)
    expect((await server.api("GET", "/status", undefined, other)).status).toBe(401)
    expect((await server.api("GET", "/status", undefined, session)).status).toBe(200)
  })
})

describe("changing the password", () => {
  test("needs the current password and a long enough new one", async () => {
    const wrong = await post("/auth/password", { current_password: "nope-nope-nope", new_password: "second-password" }, session)
    expect(wrong.status).toBe(400)
    expect(wrong.body.message).toBe("The current password is wrong")
    const short = await post("/auth/password", { current_password: "first-password", new_password: "short" }, session)
    expect(short.status).toBe(400)
    // Neither attempt cost the session.
    expect((await server.api("GET", "/auth/me", undefined, session)).status).toBe(200)
  })

  test("keeps this session, ends the others, and the old password stops working", async () => {
    const other = (await login("admin", "first-password")).body.token
    const changed = await post("/auth/password", { current_password: "first-password", new_password: "second-password" }, session)
    expect(changed.status).toBe(204)
    expect((await server.api("GET", "/auth/me", undefined, session)).status).toBe(200)
    expect((await server.api("GET", "/auth/me", undefined, other)).status).toBe(401)
    expect((await login("admin", "first-password")).status).toBe(401)
    expect((await login("admin", "second-password")).status).toBe(200)
  })
})

describe("reset-password, from the server's own shell", () => {
  test("sets a new password without the old one and signs the account out everywhere", async () => {
    const live = (await login("admin", "second-password")).body.token
    const reset = await server.run("reset-password", "admin", "--password", "recovered-password", "--data-dir", server.dataDir)
    expect(reset.code).toBe(0)
    expect(reset.stdout).toContain("Password set for Admin")
    expect((await server.api("GET", "/auth/me", undefined, live)).status).toBe(401)
    expect((await login("admin", "second-password")).status).toBe(401)
    expect((await login("admin", "recovered-password")).status).toBe(200)
  })

  test("refuses a weak password and a directory with no state", async () => {
    const weak = await server.run("reset-password", "admin", "--password", "short", "--data-dir", server.dataDir)
    expect(weak.code).toBe(1)
    expect(weak.stderr).toContain("at least 8 characters")
    const nowhere = await server.run("reset-password", "admin", "--password", "long-enough-1", "--data-dir", join(server.dataDir, "nope"))
    expect(nowhere.code).toBe(1)
    expect(nowhere.stderr).toContain("No postgres2mcp state")
  })
})

describe("a server started with a setup code", () => {
  const CODE = "s3tup-c0de-for-the-first-visitor"

  test("says so, and only creates the first account for someone who has the code", async () => {
    const guarded = await startServer({ ...NO_ACCOUNT, P2M_SETUP_TOKEN: CODE })
    try {
      const state = (await guarded.api("GET", "/auth/state", undefined, "")).body
      expect(state).toMatchObject({ setup_required: true, setup_code_required: true })

      const without = await guarded.api("POST", "/auth/setup", { username: "intruder", password: "long-enough-1" }, "")
      expect(without.status).toBe(403)
      expect(without.body.message).toContain("needs its setup code")
      const wrong = await guarded.api(
        "POST",
        "/auth/setup",
        { username: "intruder", password: "long-enough-1", setup_code: "not-the-code" },
        ""
      )
      expect(wrong.status).toBe(403)
      expect(wrong.body.message).toContain("not the one this server was started with")
      expect((await guarded.api("POST", "/auth/login", { username: "intruder", password: "long-enough-1" }, "")).status).toBe(401)
      expect((await guarded.api("GET", "/auth/state", undefined, "")).body.setup_required).toBe(true)

      const created = await guarded.api(
        "POST",
        "/auth/setup",
        { username: "owner", password: "long-enough-1", setup_code: CODE },
        ""
      )
      expect(created.status).toBe(200)
      expect(created.body.user.username).toBe("owner")
      // With an account in place the code has done its job and opens nothing more.
      expect((await guarded.api("GET", "/auth/state", undefined, "")).body).toMatchObject({
        setup_required: false,
        setup_code_required: false
      })
      const again = await guarded.api(
        "POST",
        "/auth/setup",
        { username: "second", password: "long-enough-1", setup_code: CODE },
        ""
      )
      expect(again.status).toBe(400)
    } finally {
      await guarded.stop()
    }
  })

  test("a server without an explicit code still refuses unprotected setup", async () => {
    const open = await startServer({ ...NO_ACCOUNT, P2M_SETUP_TOKEN: "" })
    try {
      expect((await open.api("GET", "/auth/state", undefined, "")).body).toMatchObject({
        setup_required: true,
        setup_code_required: true
      })
      expect((await open.api("POST", "/auth/setup", { username: "first", password: "long-enough-1" }, "")).status).toBe(403)
    } finally {
      await open.stop()
    }
  })
})

describe("an account from the environment", () => {
  test("is created at startup when none exists, and never overwrites one that does", async () => {
    const provisioned = await startServer({ P2M_ADMIN_USERNAME: "ops", P2M_ADMIN_PASSWORD: "from-the-env-1" })
    try {
      expect((await provisioned.api("GET", "/auth/state", undefined, "")).body.setup_required).toBe(false)
      expect((await provisioned.api("GET", "/auth/me")).body).toEqual({ username: "ops" })
      const setup = await provisioned.api("POST", "/auth/setup", { username: "x", password: "another-password" }, "")
      expect(setup.status).toBe(400)
    } finally {
      await provisioned.stop()
    }
  })

  test("a password too weak to accept cannot sign in", async () => {
    const weak = await startServer({ ...NO_ACCOUNT, P2M_ADMIN_USERNAME: "ops", P2M_ADMIN_PASSWORD: "short" }).catch(
      (error: Error) => error
    )
    // The harness cannot sign in, which is the point: no account was created.
    expect(weak).toBeInstanceOf(Error)
    expect(String(weak)).toContain("could not sign in")
  })
})
