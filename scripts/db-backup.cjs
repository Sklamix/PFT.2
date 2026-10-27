/**
 * Logical backup of every Prisma model to timestamped JSON files.
 *
 * Usage:
 *   $env:DATABASE_URL = '<production connection string>'
 *   npm run db:backup
 *   npm run db:backup -- --out backups/pre-launch
 *
 * This is an application-level export for point-in-time row recovery. It does
 * not replace Neon PITR/branches for full-database restore. Never commit the
 * output: `backups/` is gitignored.
 */
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { PrismaClient, Prisma } = require('@prisma/client')

function parseArgs(argv) {
  const args = { out: null }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') args.out = argv[index + 1]
  }
  return args
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function redactDatabaseUrl(value) {
  try {
    const url = new URL(value)
    return { host: url.host, database: url.pathname.replace(/^\//, '') || null }
  } catch {
    return { host: null, database: null }
  }
}

const jsonReplacer = (_key, value) => (typeof value === 'bigint' ? value.toString() : value)

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for db:backup')
  }

  const args = parseArgs(process.argv.slice(2))
  const root = path.resolve(__dirname, '..')
  const outDir = path.resolve(root, args.out || path.join('backups', timestamp()))
  fs.mkdirSync(outDir, { recursive: true })

  const prisma = new PrismaClient()
  const startedAt = new Date().toISOString()
  const models = Prisma.dmmf.datamodel.models
    .map((model) => model.name)
    .sort((left, right) => left.localeCompare(right))

  const manifest = {
    startedAt,
    finishedAt: null,
    database: redactDatabaseUrl(process.env.DATABASE_URL),
    models: [],
    totalRows: 0,
  }

  try {
    for (const model of models) {
      const delegate = prisma[model.charAt(0).toLowerCase() + model.slice(1)]
      if (!delegate || typeof delegate.findMany !== 'function') {
        throw new Error(`No Prisma delegate for model ${model}`)
      }
      const rows = await delegate.findMany()
      const payload = `${JSON.stringify(rows, jsonReplacer, 2)}\n`
      const file = `${model}.json`
      fs.writeFileSync(path.join(outDir, file), payload, 'utf8')
      manifest.models.push({
        name: model,
        rows: rows.length,
        file,
        sha256: createHash('sha256').update(payload).digest('hex'),
      })
      manifest.totalRows += rows.length
      console.log(`[pft backup] ${model}: ${rows.length} rows`)
    }

    manifest.finishedAt = new Date().toISOString()
    fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    console.log(`[pft backup] ${manifest.models.length} models, ${manifest.totalRows} rows -> ${outDir}`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error('[pft backup] failed:', error.message)
  process.exitCode = 1
})
