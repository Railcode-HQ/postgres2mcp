import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

interface EmbeddedDashboard {
  readonly version: string
  readonly files: ReadonlyArray<readonly [name: string, source: string]>
}

let embeddedDashboard: EmbeddedDashboard | null = null

/** Called by the generated binary entry before loading the CLI. */
export function registerEmbeddedDashboard(dashboard: EmbeddedDashboard): void {
  embeddedDashboard = dashboard
}

const hasBuild = (dir: string) => existsSync(join(dir, "index.html"))

/** Resolve only for `serve`, after flags and environment have selected the data directory. */
export function findWebDir(dataDir: string): string | null {
  const explicit = process.env.P2M_WEB_DIR
  // Preserve API-only mode: an explicit empty directory disables every fallback.
  if (explicit !== undefined && explicit !== "") return hasBuild(explicit) ? resolve(explicit) : null

  if (embeddedDashboard !== null) {
    const cache = resolve(dataDir, ".dashboard")
    const root = join(cache, embeddedDashboard.version)
    if (hasBuild(root)) return root

    mkdirSync(cache, { recursive: true })
    const staging = mkdtempSync(join(cache, `${embeddedDashboard.version}-`))
    try {
      for (const [name, source] of embeddedDashboard.files) {
        const target = join(staging, name)
        mkdirSync(dirname(target), { recursive: true })
        // File imports resolve inside Bun's embedded filesystem in the binary.
        // Keep Vite's HTML and module URLs intact: lazy chunks import the entry too.
        writeFileSync(target, readFileSync(source))
      }
      try {
        renameSync(staging, root)
      } catch (error) {
        // Another process may have finished extracting this same build first.
        if (!hasBuild(root)) throw error
      }
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
    return root
  }

  for (const candidate of [join(import.meta.dir, "../web/dist"), join(process.cwd(), "web/dist")]) {
    if (hasBuild(candidate)) return resolve(candidate)
  }
  return null
}
