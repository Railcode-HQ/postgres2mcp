import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"

const root = resolve(import.meta.dir, "..")
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { target: { type: "string" }, outfile: { type: "string" } },
  strict: true
})
const nativePlatform = process.platform === "win32" ? "windows" : process.platform
const target = values.target ?? `bun-${nativePlatform}-${process.arch}`
const targets = [
  "bun-linux-x64", "bun-linux-arm64", "bun-darwin-x64", "bun-darwin-arm64",
  "bun-windows-x64", "bun-windows-arm64", "bun-linux-x64-musl", "bun-linux-arm64-musl"
]
if (!targets.includes(target)) throw new Error(`Unsupported target ${target}. Choose one of: ${targets.join(", ")}`)
const extension = target.includes("windows") ? ".exe" : ""
const output = values.outfile ?? join(root, "dist", `postgres2mcp-${target.slice(4)}${extension}`)
const outfile = resolve(extension && !output.endsWith(extension) ? `${output}${extension}` : output)

async function run(args: Array<string>, cwd = root): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], { cwd, stdout: "inherit", stderr: "inherit" })
  const code = await child.exited
  if (code !== 0) throw new Error(`bun ${args.join(" ")} exited ${code}`)
}

// Build from the locked dependency trees; building must not rewrite either lockfile.
await run(["install", "--frozen-lockfile"])
await run(["install", "--frozen-lockfile"], join(root, "web"))
await run(["run", "build"], join(root, "web"))
const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: join(root, "web/dist"), onlyFiles: true }))).sort()
if (!files.includes("index.html")) throw new Error("Dashboard build has no index.html")
const digest = createHash("sha256")
for (const name of files) digest.update(name).update(readFileSync(join(root, "web/dist", name)))
const version = digest.digest("hex").slice(0, 16)

mkdirSync(join(root, "dist"), { recursive: true })
mkdirSync(dirname(outfile), { recursive: true })
const staging = mkdtempSync(join(root, "dist", ".binary-"))
try {
  const imports = files.map((name, i) =>
    `import asset${i} from ${JSON.stringify(`../../web/dist/${name}`)} with { type: "file" }`).join("\n")
  const entries = files.map((name, i) => `[${JSON.stringify(name)}, asset${i}]`).join(",\n")
  const entry = join(staging, "entry.ts")
  writeFileSync(entry, `${imports}
import { registerEmbeddedDashboard } from "../../src/dashboard.ts"
registerEmbeddedDashboard({ version: ${JSON.stringify(version)}, files: [${entries}] })
await import("../../src/bin.ts")
`)
  await run(["build", "--compile", `--target=${target}`, "--minify", entry, "--outfile", outfile], staging)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
console.log(`Built ${outfile} (${files.length} dashboard files, ${version})`)
