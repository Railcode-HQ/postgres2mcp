// Who may administer the server. Accounts are a username and a password; the
// first one is created through first-run setup (or from the environment), and
// signing in yields a session token the dashboard sends as a bearer.
import { Clock, Context, Effect, Layer, Semaphore } from "effect"
import { createHash, timingSafeEqual } from "node:crypto"
import { MIN_PASSWORD_LENGTH, type User, USERNAME_RE } from "../domain.ts"
import { BadRequest, Forbidden, TooManyAttempts, Unauthorized } from "../errors.ts"
import { AppConfig } from "./AppConfig.ts"
import { type SessionRow, Store } from "./Store.ts"

/** Sessions slide: each use pushes the expiry out again. */
export const SESSION_LIFETIME_MS = 30 * 86_400_000

const MAX_FAILURES = 5
const FAILURE_WINDOW_MS = 5 * 60_000
const MAX_PASSWORD_LENGTH = 4096
const MAX_PENDING_LOGINS = 5
const MAX_LOGIN_ATTEMPTS = 60
const LOGIN_WINDOW_MS = 60_000
const MAX_FAILURE_USERS = 1000

export interface SignedIn {
  readonly token: string
  readonly user: User
}

export class Auth extends Context.Service<Auth, {
  /** True until the first account exists. */
  readonly setupRequired: Effect.Effect<boolean>
  /** Whether creating the first account needs the server's setup code. */
  readonly setupCodeRequired: boolean
  /**
   * Create the first account. Refused once any account exists, and, on a
   * server started with a setup code, without that code.
   */
  setup(
    username: string,
    password: string,
    client: string | null,
    setupCode?: string
  ): Effect.Effect<SignedIn, BadRequest | Forbidden>
  login(
    username: string,
    password: string,
    client: string | null
  ): Effect.Effect<SignedIn, Unauthorized | TooManyAttempts>
  /** The session a bearer token belongs to, or a 401. */
  authenticate(token: string): Effect.Effect<SessionRow, Unauthorized>
  logout(token: string): Effect.Effect<void>
  /** Change a password and end the account's other sessions. */
  changePassword(
    session: SessionRow,
    token: string,
    current: string,
    next: string
  ): Effect.Effect<void, BadRequest>
  /** Set a password without knowing the old one — for the operator, from the server's own shell. */
  resetPassword(username: string, password: string): Effect.Effect<User, BadRequest>
}>()("postgres2mcp/Auth") {
  static readonly layer = Layer.effect(
    Auth,
    Effect.gen(function*() {
      const store = yield* Store
      const config = yield* AppConfig

      const hash = (password: string) => Effect.promise(() => Bun.password.hash(password))
      const verify = (password: string, stored: string) =>
        password.length > MAX_PASSWORD_LENGTH
          ? Effect.succeed(false)
          // A disconnected request must not release its slot while Argon2 is
          // still running: Bun's password verification cannot be cancelled.
          : Effect.promise(() => Bun.password.verify(password, stored).catch(() => false)).pipe(Effect.uninterruptible)

      const checkCredentials = (username: string, password: string): Effect.Effect<void, BadRequest> => {
        if (!USERNAME_RE.test(username)) {
          return Effect.fail(
            new BadRequest({ message: "Username must be 1–64 letters, digits or . _ @ - and start with a letter or digit" })
          )
        }
        if (password.length < MIN_PASSWORD_LENGTH) {
          return Effect.fail(new BadRequest({ message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` }))
        }
        if (password.length > MAX_PASSWORD_LENGTH) {
          return Effect.fail(new BadRequest({ message: `Password must be at most ${MAX_PASSWORD_LENGTH} characters` }))
        }
        return Effect.void
      }

      const createAccount = Effect.fn("Auth.createAccount")(function*(username: string, password: string) {
        yield* checkCredentials(username, password)
        return yield* store.createUser({ username, password_hash: yield* hash(password) })
      })

      // A deploy with nobody at the keyboard gets its first account from the environment.
      if (config.bootstrapAdmin !== null && (yield* store.countUsers) === 0) {
        yield* createAccount(config.bootstrapAdmin.username, config.bootstrapAdmin.password).pipe(
          Effect.tap((user) => Effect.logInfo(`Created admin account "${user.username}" from the environment`)),
          Effect.catch((error) => Effect.logWarning(`Could not create the admin account from the environment: ${error.message}`))
        )
      }

      // A real hash of a throwaway value, verified against when the username is unknown.
      const dummyHash = yield* hash("postgres2mcp-no-such-account")

      // Bound both expensive work and retained state across all usernames.
      // Per-account limits still apply, even when the global budget is free.
      const failures = new Map<string, Array<number>>()
      const pendingLogins = new Map<string, number>()
      let pendingTotal = 0
      let attempts: Array<number> = []
      const recentFailures = (key: string, now: number) => {
        const recent = (failures.get(key) ?? []).filter((at) => now - at < FAILURE_WINDOW_MS)
        if (recent.length === 0) failures.delete(key)
        else failures.set(key, recent)
        return recent
      }

      const setupRequired = Effect.map(store.countUsers, (count) => count === 0)

      // Compared as digests, so the time taken says nothing about the code.
      const digest = (value: string) => createHash("sha256").update(value).digest()
      const setupCode = config.setupToken === null ? null : digest(config.setupToken)

      // One setup at a time: two first visitors must not both become "the first".
      const setupLock = yield* Semaphore.make(1)
      const setup = (username: string, password: string, client: string | null, code?: string) =>
        Semaphore.withPermits(setupLock, 1)(Effect.gen(function*() {
          if ((yield* store.countUsers) > 0) {
            return yield* new BadRequest({ message: "Setup is already complete. Sign in instead." })
          }
          if (setupCode !== null && !timingSafeEqual(digest(code ?? ""), setupCode)) {
            return yield* new Forbidden({
              message: code === undefined || code === ""
                ? "This server needs its setup code to create the first account. Use the link the installer printed, or find the code in the server's startup log."
                : "That setup code is not the one this server was started with."
            })
          }
          const user = yield* createAccount(username.trim(), password)
          return { token: yield* store.createSession(user.id, SESSION_LIFETIME_MS, client), user }
        }))

      const login = Effect.fn("Auth.login")(function*(username: string, password: string, client: string | null) {
        if (username.length > 256 || !USERNAME_RE.test(username.trim()) || password.length > MAX_PASSWORD_LENGTH) {
          return yield* new Unauthorized({ message: "Wrong username or password" })
        }
        const key = username.trim().toLowerCase()
        return yield* Effect.acquireUseRelease(
          Effect.gen(function*() {
            const now = yield* Clock.currentTimeMillis
            // Sweep all expired entries, including names that never return.
            for (const name of failures.keys()) recentFailures(name, now)
            attempts = attempts.filter((at) => now - at < LOGIN_WINDOW_MS)
            if (pendingTotal >= MAX_PENDING_LOGINS || attempts.length >= MAX_LOGIN_ATTEMPTS) {
              return yield* new TooManyAttempts({ message: "Too many sign-in attempts. Try again shortly." })
            }
            const recent = recentFailures(key, now)
            const pending = pendingLogins.get(key) ?? 0
            if (recent.length >= MAX_FAILURES) {
              const wait = Math.ceil((FAILURE_WINDOW_MS - (now - recent[0]!)) / 1000)
              return yield* new TooManyAttempts({ message: `Too many failed sign-ins. Try again in ${wait} seconds.` })
            }
            if (recent.length + pending >= MAX_FAILURES) {
              return yield* new TooManyAttempts({ message: "Too many sign-in attempts in progress. Try again shortly." })
            }
            // Reserve before any I/O so concurrent guesses share the same budget.
            pendingLogins.set(key, pending + 1)
            pendingTotal++
            attempts.push(now)
          }),
          () => Effect.gen(function*() {
            const user = yield* store.findUser(username.trim())
            // Verify against something even when the account does not exist, so the
            // response time does not reveal which usernames are real.
            const ok = yield* verify(password, user?.password_hash ?? dummyHash)
            if (user === null || !ok) {
              const now = yield* Clock.currentTimeMillis
              if (!failures.has(key) && failures.size >= MAX_FAILURE_USERS) {
                failures.delete(failures.keys().next().value!)
              }
              failures.set(key, [...recentFailures(key, now), now])
              return yield* new Unauthorized({ message: "Wrong username or password" })
            }
            failures.delete(key)
            const { password_hash: _, ...publicUser } = user
            return { token: yield* store.createSession(user.id, SESSION_LIFETIME_MS, client), user: publicUser }
          }),
          () => Effect.sync(() => {
            pendingTotal--
            const remaining = pendingLogins.get(key)! - 1
            if (remaining === 0) pendingLogins.delete(key)
            else pendingLogins.set(key, remaining)
          })
        )
      })

      const authenticate = (token: string) =>
        Effect.flatMap(
          store.touchSession(token, SESSION_LIFETIME_MS),
          (session): Effect.Effect<SessionRow, Unauthorized> =>
            session === null
              ? Effect.fail(new Unauthorized({ message: "Not signed in, or the session has expired" }))
              : Effect.succeed(session)
        )

      const changePassword = Effect.fn("Auth.changePassword")(function*(
        session: SessionRow,
        token: string,
        current: string,
        next: string
      ) {
        const user = yield* store.findUser(session.username)
        if (user === null || !(yield* verify(current, user.password_hash))) {
          // Not a 401: the session is fine, it is the form that is wrong.
          return yield* new BadRequest({ message: "The current password is wrong" })
        }
        yield* checkCredentials(user.username, next)
        yield* store.setPassword(user.id, yield* hash(next))
        yield* store.deleteSessionsOf(user.id, token)
      })

      const resetPassword = Effect.fn("Auth.resetPassword")(function*(username: string, password: string) {
        const user = yield* store.findUser(username.trim())
        if (user === null) {
          // No such account: the operator is (re)creating the way in.
          return yield* createAccount(username.trim(), password)
        }
        yield* checkCredentials(user.username, password)
        yield* store.setPassword(user.id, yield* hash(password))
        yield* store.deleteSessionsOf(user.id)
        const { password_hash: _, ...publicUser } = user
        return publicUser
      })

      return Auth.of({
        setupRequired,
        setupCodeRequired: setupCode !== null,
        setup,
        login,
        authenticate,
        logout: store.deleteSession,
        changePassword,
        resetPassword
      })
    })
  )
}
