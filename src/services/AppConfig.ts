import { Context } from "effect"

/**
 * Everything the server needs to know, resolved once at startup from flags and
 * environment variables (see `src/commands.ts` for the precedence).
 */
export class AppConfig extends Context.Service<AppConfig, {
  /** Connection string of the Postgres database being exposed. */
  readonly databaseUrl: string
  readonly host: string
  readonly port: number
  /** Where the SQLite state file lives (accounts, keys, groups, custom tools, logs). */
  readonly dataDir: string
  /**
   * An admin account to create at startup when none exists yet — for deploys
   * where nobody will be there to click through first-run setup.
   */
  readonly bootstrapAdmin: { readonly username: string; readonly password: string } | null
  /**
   * When set, creating the first account through the dashboard needs this
   * code — so that on a server others can reach, "the first visitor" is the
   * person who started it. `serve` always supplies a configured or generated
   * code; null is used by non-HTTP commands.
   */
  readonly setupToken: string | null
  /**
   * The address clients reach this server at, when that is not the address it
   * listens on (a reverse proxy, a domain). Only used to show the right URLs.
   */
  readonly publicUrl: string | null
  /** Row cap applied to every result set. */
  readonly maxRows: number
  /** Approximate cap on the serialized size of a result set. */
  readonly maxBytes: number
  /** Server-side `statement_timeout` applied to every statement. */
  readonly queryTimeoutMs: number
  /** Log rows older than this are pruned. 0 keeps them forever. */
  readonly logRetentionDays: number
  /** Max connections held against the target database. */
  readonly poolSize: number
  /** Directory holding the built dashboard, or null to run API-only. */
  readonly webDir: string | null
}>()("postgres2mcp/AppConfig") {}

export const DEFAULTS = {
  host: "0.0.0.0",
  port: 3333,
  dataDir: "./data",
  maxRows: 1000,
  maxBytes: 2_000_000,
  queryTimeoutMs: 15_000,
  logRetentionDays: 30,
  poolSize: 5
} as const
