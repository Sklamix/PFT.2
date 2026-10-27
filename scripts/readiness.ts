/**
 * Release readiness report for operators.
 *
 * Usage:
 *   npm run doctor
 *   $env:DATABASE_URL = '<production connection string>'; npm run doctor
 *
 * Exits with code 1 when a blocker is present, so it can gate a release.
 */
import fs from 'node:fs'
import path from 'node:path'

function loadEnvFile(file: string) {
  if (!fs.existsSync(file)) return
  const content = fs.readFileSync(file, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const [, key, raw] = match
    if (process.env[key] !== undefined) continue
    process.env[key] = raw.trim().replace(/^['"]|['"]$/g, '')
  }
}

const ICONS = { blocker: '[BLOCKER]', warning: '[warning]', ok: '[ok]     ' } as const

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env.local'))
  loadEnvFile(path.resolve(process.cwd(), '.env'))

  const { collectReadiness } = await import('../lib/ops/readiness')
  const report = await collectReadiness()

  console.log(`\nPFT release readiness — ${report.generatedAt}\n`)
  let area = ''
  for (const check of report.checks) {
    if (check.area !== area) {
      area = check.area
      console.log(`\n${area.toUpperCase()}`)
    }
    console.log(`  ${ICONS[check.severity]} ${check.label}: ${check.detail}`)
    if (check.hint) console.log(`             -> ${check.hint}`)
  }

  console.log(
    `\n${report.blockers} blocker(s), ${report.warnings} warning(s), ${report.checks.length - report.blockers - report.warnings} ok\n`,
  )
  if (report.blockers > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('[pft doctor] failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
