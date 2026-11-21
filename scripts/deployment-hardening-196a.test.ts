import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * PHASE 1.96a: build lifecycle, realtime route and TypeScript gate regressions.
 * Static DB-free checks; no build or DB connection is started here.
 */

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
const pkg = JSON.parse(source('package.json')) as { scripts: Record<string, string> }

test('build lifecycle: npm build does not run bootstrap, migrations or seed', () => {
  assert.equal(pkg.scripts.build, 'next build')
  assert.equal(pkg.scripts.prebuild, undefined, 'prebuild must not exist')
  assert.equal(pkg.scripts.postbuild, undefined, 'postbuild must not exist')
  assert.doesNotMatch(
    pkg.scripts.build,
    /bootstrap-production|migrate-stress|prisma|seed|test:/,
  )
})

test('build lifecycle: DB operations live in separate explicitly gated scripts', () => {
  assert.match(pkg.scripts['db:bootstrap:production'], /bootstrap-production\.cjs/)
  assert.match(pkg.scripts['db:migrate:stress'], /migrate-stress-test\.cjs/)
  assert.ok(!pkg.scripts['test:unit'].includes('bootstrap-production'))
  assert.ok(!pkg.scripts['test:unit'].includes('migrate-stress'))
})

test('build lifecycle: scripts stay inert without their explicit opt-in even if build env leaks flags', () => {
  for (const file of ['scripts/bootstrap-production.cjs', 'scripts/migrate-stress-test.cjs']) {
    const src = source(file)
    assert.match(src, /process\.env\.PFT_(BOOTSTRAP|STRESS_MIGRATIONS) !== '1'/, `${file}: guard`)
    assert.match(src, /process\.exit\(0\)/, `${file}: no-op exit`)
    assert.match(src, /NOT part of the build lifecycle/, `${file}: documented isolation`)
  }
  // The build command itself never references either flag or script.
  assert.doesNotMatch(pkg.scripts.build, /PFT_|bootstrap|migrat/i)
})

test('type safety: production build no longer ignores TypeScript errors', () => {
  const config = source('next.config.mjs')
  assert.doesNotMatch(config, /ignoreBuildErrors:\s*true/)
  assert.match(config, /ignoreBuildErrors:\s*false/)
  assert.match(pkg.scripts['test:unit'], /test:preflight/)
})

test('realtime demo route: no module-scope pool and no import-time DATABASE_URL read', () => {
  const src = source('app/api/realtime/notes/route.ts')
  assert.match(src, /let pool: Pool \| null = null/)
  assert.match(src, /function getPool\(\): Pool/)
  assert.doesNotMatch(src, /^const pool = new Pool/m)
  assert.match(src, /^ {4}pool = new Pool\(/m, 'pool construction stays inside getPool()')
  assert.match(src, /if \(!databaseUrl\) throw new Error/)
  assert.match(src, /getPool\(\)\.query/)
})

test('client exposure: no bootstrap credentials or mock desk hints in client components', () => {
  const src = source('app/admin/login/page.tsx')
  assert.doesNotMatch(src, /PFT-Admin-Desk|PFT-Risk-Desk|Mock desk|ops@pft\.local/)
})
