// The installer, as far as it can be checked without Docker: what it accepts,
// and that it refuses bad input before it touches anything. The steps that
// build and start containers are exercised by running it for real.
import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ROOT } from "./harness.ts"

const INSTALLER = join(ROOT, "install.sh")

/** Run the installer against an empty directory, with no terminal to ask. */
const install = async (args: Array<string>, options: { piped?: boolean; env?: Record<string, string> } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "p2m-install-"))
  const proc = Bun.spawn(
    options.piped ? ["bash", "-s", "--", "--dir", dir, ...args] : ["bash", INSTALLER, "--dir", dir, ...args],
    {
      // No DATABASE_URL or P2M_* from the developer's shell.
      env: { PATH: process.env.PATH ?? "", HOME: dir, NO_COLOR: "1", ...options.env },
      stdin: options.piped ? Bun.file(INSTALLER) : "ignore",
      stdout: "pipe",
      stderr: "pipe"
    }
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  const left = readdirSync(dir)
  rmSync(dir, { recursive: true, force: true })
  return { code, stdout, stderr, left }
}

describe("install.sh", () => {
  test("is valid for the bash that macOS ships, and executable", async () => {
    const check = Bun.spawn(["bash", "-n", INSTALLER], { stderr: "pipe" })
    expect(await new Response(check.stderr).text()).toBe("")
    expect(await check.exited).toBe(0)
    const text = readFileSync(INSTALLER, "utf8")
    // bash 3.2 has none of these.
    for (const tooNew of ["declare -A", "mapfile", "readarray", "${1,,}", "local -n"]) expect(text).not.toContain(tooNew)
    expect(existsSync(INSTALLER)).toBe(true)
  })

  test("--help names every option, also when the script arrives on stdin", async () => {
    for (const piped of [false, true]) {
      const help = await install(["--help"], { piped })
      expect(help.code).toBe(0)
      for (const option of ["--database-url", "--domain", "--port", "--dir", "--skip-dns-check", "--yes", "--uninstall"]) {
        expect(help.stdout).toContain(option)
      }
    }
  })

  test("refuses what it cannot act on, before changing anything", async () => {
    const unknown = await install(["--frobnicate"])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain("Unknown option: --frobnicate")

    const nothing = await install(["--yes"])
    expect(nothing.code).toBe(1)
    expect(nothing.stderr).toContain("No database to expose.")
    expect(nothing.stderr).toContain("--database-url")

    const notPostgres = await install(["--yes", "--database-url", "mysql://root:hunter2@db/app"])
    expect(notPostgres.code).toBe(1)
    expect(notPostgres.stderr).toContain("is not a Postgres connection string")
    // A password in what was typed is not echoed back.
    expect(notPostgres.stderr).not.toContain("hunter2")

    const badDomain = await install(["--yes", "--database-url", "postgres://u:p@db/app", "--domain", "not a domain"])
    expect(badDomain.code).toBe(1)
    expect(badDomain.stderr).toContain("is not a domain name")

    const badPort = await install(["--yes", "--database-url", "postgres://u:p@db/app", "--port", "http"])
    expect(badPort.code).toBe(1)
    expect(badPort.stderr).toContain("is not a port number")

    for (const run of [unknown, nothing, notPostgres, badDomain, badPort]) expect(run.left).toEqual([])
  })

  test("stops at a Docker that does not answer, and says what to do", async () => {
    // A docker (and a sudo) that are there and fail, ahead of the real ones.
    const stubs = mkdtempSync(join(tmpdir(), "p2m-stubs-"))
    for (const name of ["docker", "sudo"]) {
      writeFileSync(join(stubs, name), "#!/bin/sh\nexit 1\n")
      chmodSync(join(stubs, name), 0o755)
    }
    const result = await install(["--yes", "--database-url", "postgres://u:p@db/app"], {
      env: { PATH: `${stubs}:${process.env.PATH ?? ""}` }
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("Docker is installed, but not answering.")
    expect(result.stderr).toContain("systemctl start docker")
    expect(result.left).toEqual([])

    // What was passed is still judged first: a bad argument is not a reason to look for Docker.
    const bad = await install(["--yes", "--database-url", "mysql://db/app"], {
      env: { PATH: `${stubs}:${process.env.PATH ?? ""}` }
    })
    rmSync(stubs, { recursive: true, force: true })
    expect(bad.stderr).toContain("is not a Postgres connection string")
    expect(bad.stderr).not.toContain("Docker")
  })

  test("--uninstall says so when there is nothing installed", async () => {
    const result = await install(["--uninstall", "--yes"])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("No postgres2mcp install found")
  })
})
