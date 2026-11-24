/**
 * Minimal `.env` reader for the maintenance scripts.
 *
 * Next.js loads `.env.local` automatically; the Prisma CLI and the standalone
 * scripts in `scripts/` do not. That asymmetry is dangerous here, because
 * `.env.local` points at the Neon **preview** branch while production uses a
 * different database — running `prisma db push` without this loader either
 * fails ("Environment variable not found: DATABASE_URL") or, worse, succeeds
 * against the wrong database.
 *
 * No dependency: `dotenv` is not installed and this needs about twenty lines.
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')

/** Parses `KEY=value`, ignoring comments, blank lines and `export` prefixes. */
function parseEnvFile(filePath) {
  const out = {}
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return out
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line
    const eq = withoutExport.indexOf('=')
    if (eq === -1) continue

    const key = withoutExport.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue

    let value = withoutExport.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }

  return out
}

/**
 * Loads env files into `process.env` without overwriting variables that are
 * already set.
 *
 * Precedence, highest first:
 *   1. variables already exported in the shell
 *   2. files in the order given — earlier files win
 *
 * So callers pass the most specific file first, e.g.
 * `loadEnv(['.env.production.local', '.env.local', '.env'])`.
 *
 * @param {string[]} files file names relative to the repo root, most specific first
 * @returns {{ loaded: string[], values: Record<string, string> }}
 */
function loadEnv(files = ['.env.local', '.env']) {
  const loaded = []
  const values = {}

  for (const file of files) {
    const full = path.join(ROOT, file)
    const parsed = parseEnvFile(full)
    const keys = Object.keys(parsed)
    if (keys.length === 0) continue

    loaded.push(file)
    for (const key of keys) {
      values[key] = parsed[key]
      if (process.env[key] === undefined) process.env[key] = parsed[key]
    }
  }

  return { loaded, values }
}

/**
 * Returns a connection string safe to print: host and database only, with any
 * credentials stripped.
 */
function describeDatabaseUrl(value) {
  try {
    const url = new URL(value)
    return {
      host: url.hostname,
      database: url.pathname.replace(/^\//, '') || null,
      branch: url.hostname.match(/-([a-z]+-[a-z]+-[a-z0-9]+)-/)?.[1] ?? null,
    }
  } catch {
    return { host: null, database: null, branch: null }
  }
}

module.exports = { loadEnv, parseEnvFile, describeDatabaseUrl, ROOT }
