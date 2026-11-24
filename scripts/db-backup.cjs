/**
 * Logical backup of every Prisma model to timestamped JSON files.
 *
 * Usage:
 *   npm run db:backup                          # whatever DATABASE_URL points at
 *   npm run db:backup -- --out backups/pre-x
 *   npm run db:backup -- --prod --out backups/prod-pre-x
 *
 * Reads `DATABASE_URL` from the environment, falling back to `.env.local`,
 * `.env.production.local` and `.env`. `--prod` switches to
 * `PFT_PROD_DATABASE_URL` explicitly. The target host and branch are printed
 * before anything is read — preview and production are different Neon branches,
 * and a backup of the wrong one is worse than no backup at all.
 *
 * This is an application-level export for point-in-time row recovery. It does
 * not replace Neon PITR/branches for full-database restore. Never commit the
 * output: `backups/` is gitignored.
 */
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { PrismaClient, Prisma } = require('@prisma/client')

const { loadEnv, describeDatabaseUrl } = require('./db-env.cjs')

// Prisma and this script do not read `.env.local` on their own — only Next.js
// does. Load it so `npm run db:backup` works without exporting DATABASE_URL by
// hand, and so the target can be printed below.
loadEnv(['.env.production.local', '.env.local', '.env'])

function parseArgs(argv) {
  const args = { out: null, prod: false }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') args.out = argv[index + 1]
    if (argv[index] === '--prod') args.prod = true
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

/**
 * A model can be in the schema while its table is not created yet — that is
 * exactly the state right before `prisma db push`. Treat a missing table as an
 * empty table so the backup still completes; any other error must abort.
 */
async function readRows(delegate, model) {
  try {
    return await delegate.findMany()
  } catch (error) {
    if (error?.code !== 'P2021') throw error
    console.warn(`[pft backup] ${model}: table does not exist yet, backing up as empty`)
    return []
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  // `--prod` reads the production string explicitly instead of relying on which
  // env file happened to win. Preview and production are different Neon
  // branches, and a backup of the wrong one is worse than no backup at all.
  if (args.prod) {
    const prodUrl = process.env.PFT_PROD_DATABASE_URL
    if (!prodUrl) {
      throw new Error(
        '--prod requires PFT_PROD_DATABASE_URL (set it in .env.production.local). ' +
          'The production string is not readable from Vercel: sensitive variables are write-only.',
      )
    }
    process.env.DATABASE_URL = prodUrl
  }

  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is required for db:backup (checked .env.local, .env.production.local, .env)',
    )
  }

  // Print which database is about to be read.
  const target = describeDatabaseUrl(process.env.DATABASE_URL)
  const branch = args.prod ? 'production (explicit)' : process.env.NEON_BRANCH || null
  console.log(
    `[pft backup] target: ${target.host}/${target.database}${branch ? ` (branch: ${branch})` : ''}`,
  )
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
      const rows = await readRows(delegate, model)
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
