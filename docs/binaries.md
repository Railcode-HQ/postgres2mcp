# Building a standalone binary

The binary includes the CLI, Bun runtime, SQLite support, and built dashboard. Running it needs neither Bun nor Node.js, Docker, or a separate `web/dist` directory. Postgres still runs separately.

## Build

Install [Bun](https://bun.com/docs/installation), then from the repository root:

```sh
bun run build:binary
```

The build installs dependencies from both frozen lockfiles, builds the dashboard, and compiles an executable for the current operating system and architecture under `dist/`. For example, an Apple Silicon Mac produces `dist/postgres2mcp-darwin-arm64`.

Select another target or output path explicitly:

```sh
bun run build:binary --target bun-linux-x64 --outfile dist/postgres2mcp
```

Supported build targets:

- `bun-linux-x64`, `bun-linux-arm64` (glibc)
- `bun-linux-x64-musl`, `bun-linux-arm64-musl` (Alpine/musl)
- `bun-darwin-x64`, `bun-darwin-arm64`
- `bun-windows-x64`, `bun-windows-arm64` (output defaults to `.exe`)

Cross-compilation creates an executable for that target; it does not run or validate it there. Use a matching machine to test it. Build with the same Bun version when reproducing a build.

## Run

Copy just the executable to the target machine. Existing flags and environment variables work as they do with the source CLI:

```sh
DATABASE_URL='postgres://user:password@host:5432/dbname' ./postgres2mcp serve --data-dir ./data
```

Open the setup link printed at startup to create the admin account. The default HTTP port is `3333`, overridable with `PORT` or `--port`. For public deployments, put an HTTPS reverse proxy in front and set `P2M_PUBLIC_URL`; see [deployment](deployment.md).

The other commands work from the same executable:

```sh
./postgres2mcp stdio --database-url 'postgres://user:password@host:5432/dbname'
./postgres2mcp reset-password admin --data-dir ./data
```

## Dashboard and state

On the first `serve` for a given dashboard build, its embedded files are extracted under `<data-dir>/.dashboard/<content-hash>`. Extraction uses a temporary directory and an atomic rename, so an interrupted start does not leave a partially published build. Subsequent starts reuse it. `--data-dir` takes precedence over `P2M_DATA_DIR`, and the default stays `./data`.

The HTML and asset paths are kept exactly as Vite built them, including the imports shared by lazy pages. Applying a query string only to the entry script would cause those pages to load a second copy of React.

`P2M_WEB_DIR` overrides the embedded dashboard. Point it at another build to serve that dashboard, or at an empty/nonexistent directory for API-only mode. Help, version, `stdio`, and `reset-password` do not extract dashboard assets. The source CLI retains its existing dashboard lookup.

Accounts, key hashes, custom tools, and logs remain in `<data-dir>/postgres2mcp.db`. Upgrading the executable keeps this state and selects the dashboard embedded in the new build. Old `.dashboard` versions can be removed while the server is stopped; the next `serve` can recreate its own version from the executable. Back up the database and your configuration as described in [deployment](deployment.md#day-to-day).

## Test the packaged executable

```sh
bun run test:binary
```

This builds a native executable and starts it from empty working directories. It checks embedded assets and module URLs, setup and authentication, MCP, state persistence, configuration overrides, stdio, and password reset without requiring Postgres. Set `TEST_DATABASE_URL` to a disposable test database to also verify a read-only `SELECT 1` through MCP.

To test an already-built executable on its matching platform:

```sh
P2M_TEST_BINARY=/absolute/path/to/postgres2mcp bun run test:binary
```

Bun is required only to run the test harness, not to run the packaged executable.
