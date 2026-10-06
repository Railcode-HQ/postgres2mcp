// End-to-end test harness: a real Postgres database, and the real server
// started the way a user starts it — `postgres2mcp serve` as a subprocess.
//
// The database defaults to `postgres2mcp_test` on a local Postgres; point
// TEST_DATABASE_URL elsewhere to use another one. Its `public` schema is
// dropped and rebuilt on every run.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"

export const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost/postgres2mcp_test"
export const ROOT = join(import.meta.dir, "..")
export const BIN = join(ROOT, "src/bin.ts")
export const ADMIN_USERNAME = "admin"
export const ADMIN_PASSWORD = "test-password-1"

const SEED = `
DROP SCHEMA IF EXISTS public CASCADE;
DROP SCHEMA IF EXISTS billing CASCADE;
CREATE SCHEMA public;
CREATE SCHEMA billing;
CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped');
CREATE TABLE customers (
  id serial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT '2026-01-02 03:04:05+00'
);
COMMENT ON TABLE customers IS 'People who buy things';
COMMENT ON COLUMN customers.email IS 'Login address';
CREATE TABLE orders (
  id bigserial PRIMARY KEY,
  customer_id int NOT NULL REFERENCES customers(id),
  status order_status NOT NULL DEFAULT 'pending',
  total numeric(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  placed_on date NOT NULL DEFAULT '2026-01-02'
);
CREATE INDEX orders_customer_idx ON orders (customer_id);
CREATE VIEW paid_orders AS SELECT id, total FROM orders WHERE status = 'paid';
CREATE TABLE billing.invoices (id serial PRIMARY KEY, order_id bigint REFERENCES orders(id), amount numeric);
CREATE TABLE scratch (id serial PRIMARY KEY, note text);
CREATE TABLE doomed (id int);
CREATE TABLE "Odd ""Name" (id int);
INSERT INTO customers (email, name) SELECT 'user' || g || '@example.com', 'User ' || g FROM generate_series(1, 20) g;
INSERT INTO orders (customer_id, status, total)
  SELECT 1 + g % 20, (ARRAY['pending','paid','shipped'])[1 + g % 3]::order_status, g * 1.5 FROM generate_series(1, 300) g;
INSERT INTO scratch (note) VALUES ('a'), ('b'), ('c');
INSERT INTO doomed VALUES (1);
ANALYZE;
`

/** Create the test database if needed, then rebuild its contents. */
export async function seedDatabase(): Promise<void> {
  const target = new URL(DATABASE_URL)
  const name = target.pathname.slice(1)
  const maintenance = new URL(DATABASE_URL)
  maintenance.pathname = "/postgres"
  const admin = new pg.Client({ connectionString: maintenance.toString() })
  await admin.connect()
  try {
    const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])
    if (existing.rowCount === 0) await admin.query(`CREATE DATABASE "${name.replaceAll("\"", "\"\"")}"`)
  } finally {
    await admin.end()
  }
  const client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()
  try {
    await client.query(SEED)
  } finally {
    await client.end()
  }
}

/** Run SQL straight against the test database, bypassing postgres2mcp. */
export async function direct<Row extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: Array<unknown> = []
): Promise<Array<Row>> {
  const client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()
  try {
    return (await client.query<Row>(sql, params)).rows
  } finally {
    await client.end()
  }
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") })
  const port = probe.port!
  await probe.stop(true)
  return port
}

export interface TestServer {
  readonly url: string
  readonly dataDir: string
  readonly env: Record<string, string>
  /** The admin session every `api()` call uses unless told otherwise. */
  readonly session: string
  /** Call the admin API. Pass `token: ""` to call it signed out. */
  api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: any }>
  /** POST one JSON-RPC message to /mcp with an API key. */
  rpc(token: string | null, message: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>
  /** Run the binary with this server's environment and collect its output. */
  run(...args: Array<string>): Promise<{ code: number; stdout: string; stderr: string }>
  stop(): Promise<void>
}

export async function startServer(extraEnv: Record<string, string> = {}): Promise<TestServer> {
  const port = await freePort()
  const dataDir = mkdtempSync(join(tmpdir(), "p2m-test-"))
  const url = `http://127.0.0.1:${port}`
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    // libpq-style defaults (user, password) still come from the environment.
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] =>
        entry[1] !== undefined && (entry[0] === "USER" || entry[0].startsWith("PG"))
      )
    ),
    HOME: dataDir,
    DATABASE_URL,
    PORT: String(port),
    HOST: "127.0.0.1",
    P2M_DATA_DIR: dataDir,
    // The server creates this account at startup; the harness signs in with it.
    P2M_ADMIN_USERNAME: ADMIN_USERNAME,
    P2M_ADMIN_PASSWORD: ADMIN_PASSWORD,
    // No dashboard build is needed (or wanted) for API tests.
    P2M_WEB_DIR: join(dataDir, "no-web"),
    ...extraEnv
  }
  const child = Bun.spawn(["bun", BIN, "serve"], { env, cwd: dataDir, stdout: "pipe", stderr: "pipe" })

  const deadline = Date.now() + 15_000
  for (;;) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) break
    } catch {
      // not listening yet
    }
    if (child.exitCode !== null || Date.now() > deadline) {
      const output = await new Response(child.stdout).text() + await new Response(child.stderr).text()
      throw new Error(`server did not start:\n${output}`)
    }
    await Bun.sleep(50)
  }

  const parse = async (response: Response) => {
    const text = await response.text()
    try {
      return text === "" ? null : JSON.parse(text)
    } catch {
      return text
    }
  }

  // Sign in once, the way the dashboard does, unless this server starts without an account.
  let session = ""
  if (env.P2M_ADMIN_USERNAME !== "") {
    const login = await fetch(`${url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: env.P2M_ADMIN_USERNAME, password: env.P2M_ADMIN_PASSWORD })
    })
    if (!login.ok) {
      child.kill()
      await child.exited
      rmSync(dataDir, { recursive: true, force: true })
      throw new Error(`could not sign in to the test server: ${login.status} ${await login.text()}`)
    }
    session = ((await login.json()) as { token: string }).token
  }

  return {
    url,
    dataDir,
    env,
    session,
    async api(method, path, body, token = session) {
      const response = await fetch(`${url}/api${path}`, {
        method,
        headers: {
          ...(token === "" ? {} : { authorization: `Bearer ${token}` }),
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
      return { status: response.status, body: await parse(response) }
    },
    async rpc(token, message, headers = {}) {
      const response = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...headers
        },
        body: typeof message === "string" ? message : JSON.stringify(message)
      })
      return { status: response.status, body: await parse(response) }
    },
    async run(...args) {
      const proc = Bun.spawn(["bun", BIN, ...args], { env, cwd: dataDir, stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited
      ])
      return { code, stdout, stderr }
    },
    async stop() {
      child.kill()
      await child.exited
      rmSync(dataDir, { recursive: true, force: true })
    }
  }
}
