/**
 * Unit tests for the shared test-database identity gate (scripts/observability-db-gate.ts).
 *
 * Fully mocked: env records are passed as plain objects, no process.env access,
 * no database, no network, no credentials on the disk. Real connection strings
 * are NEVER stored here — hostnames/usernames/passwords below are synthetic
 * (doc examples only) and every gate `use` result URL is only inspected
 * through structural properties, never printed wholesale.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ALLOWED_TEST_DB_HOSTS,
  FORBIDDEN_TEST_DATABASE_URLS,
  REQUIRED_TEST_DB_NAME,
  REQUIRED_TEST_DB_ROLE,
  REQUIRED_TEST_DB_PORT,
  assertClientIsTestDb,
  assertGateAllowsExecution,
  normalizedEndpoint,
  resolveObservabilityTestDb,
} from './observability-db-gate'
import { readFileSync } from 'node:fs'

const APPROVED_HOST = 'ep-icy-king-b4ozchkf.c-6.us-east-2.aws.neon.tech'
// Synthetic doc-style credentials; not real secrets.
const APPROVED = `postgresql://docuser:docpass@${APPROVED_HOST}/pft_dbtest`
const APPROVED_UNPOOLED = `postgres://docuser:docpass@${APPROVED_HOST}/pft_dbtest`
const WRONG_HOST = `postgresql://docuser:docpass@ep-wrong-host-999999.us-east-2.aws.neon.tech/pft_dbtest`
const PROD_HOST = `postgresql://docuser:docpass@ep-jolly-resonance-123456.us-east-2.aws.neon.tech/pft_dbtest`
const WRONG_DB = `postgresql://docuser:docpass@${APPROVED_HOST}/neondb`
// Preview and unverified host variants must remain rejected.
const STALE_HOST = `postgresql://docuser:docpass@ep-cool-darkness-123456.us-east-2.aws.neon.tech/pft_dbtest`
const PREVIEW_HOST = `postgresql://docuser:docpass@ep-curly-frog-b4m2x6hl.c-6.us-east-2.aws.neon.tech/pft_dbtest`
const POOLER_HOST = `postgresql://docuser:docpass@ep-icy-king-b4ozchkf.c-6.us-east-2.aws.neon.tech-pooler/pft_dbtest`

test('module invariants: one approved host, denylist is production-only, db name fixed', () => {
  assert.equal(ALLOWED_TEST_DB_HOSTS.length, 1)
  assert.equal(FORBIDDEN_TEST_DATABASE_URLS.length, 1)
  assert.match(FORBIDDEN_TEST_DATABASE_URLS[0].source, /jolly/)
  assert.equal(REQUIRED_TEST_DB_NAME, 'pft_dbtest')
})

test('normalization: hostname lowercased, credentials irrelevant for endpoint equality', () => {
  const a = normalizedEndpoint(`postgres://other:creds@${APPROVED_HOST.toUpperCase()}/pft_dbtest`)
  const b = normalizedEndpoint(APPROVED)
  assert.equal(a, b)
})

// --- env policy (PHASE 1.10.21/22) -------------------------------------------

test('no opt-in -> skip (no connection)', () => {
  const r = resolveObservabilityTestDb({})
  assert.equal(r.action, 'skip')
  assert.ok(r.reason.length > 0)
})

test('flag set but URL missing -> STOP (opt-in without URL is a config error, no fallback)', () => {
  const r = resolveObservabilityTestDb({ OBSERVABILITY_TEST_DB: '1' })
  assert.equal(r.action, 'stop')
})

test('flag set, non-postgres URL -> fail-closed', () => {
  const r = resolveObservabilityTestDb({ OBSERVABILITY_TEST_DB: '1', OBSERVABILITY_TEST_DB_URL: 'mysql://x@h/db' })
  assert.notEqual(r.action, 'use')
})

test('canonical opted in and approved -> use with require+strict appended when TLS params missing (PHASE 1.67)', () => {
  const r = resolveObservabilityTestDb({ OBSERVABILITY_TEST_DB: '1', OBSERVABILITY_TEST_DB_URL: APPROVED })
  assert.equal(r.action, 'use')
  if (r.action === 'use') {
    const u = new URL(r.url)
    assert.equal(u.hostname, APPROVED_HOST)
    assert.equal(u.pathname, '/pft_dbtest')
    assert.equal(u.searchParams.get('sslmode'), 'require')
    assert.equal(u.searchParams.get('sslaccept'), 'strict')
  }
})

test('explicit sslmode=verify-full (legacy) accepted and canonicalized to require+strict (PHASE 1.67)', () => {
  const r = resolveObservabilityTestDb({
    OBSERVABILITY_TEST_DB: '1',
    OBSERVABILITY_TEST_DB_URL: `${APPROVED}?sslmode=verify-full`,
  })
  assert.equal(r.action, 'use')
  if (r.action === 'use') {
    const u = new URL(r.url)
    assert.equal(u.searchParams.getAll('sslmode').join(','), 'require')
    assert.equal(u.searchParams.get('sslaccept'), 'strict')
  }
})

test('sslmode=verify-ca / prefer / disable / bogus -> stop (no downgrade)', () => {
  for (const m of ['verify-ca', 'prefer', 'disable', 'bogus']) {
    const r = resolveObservabilityTestDb({
      OBSERVABILITY_TEST_DB: '1',
      OBSERVABILITY_TEST_DB_URL: `${APPROVED}?sslmode=${m}`,
    })
    assert.equal(r.action, 'stop', `sslmode=${m} must stop`)
    assert.ok(!('url' in r), 'stop results must not carry a URL')
  }
})

test('sslmode=require alone is hardening-compatible: canonicalized to require+strict (PHASE 1.67)', () => {
  const r = resolveObservabilityTestDb({
    OBSERVABILITY_TEST_DB: '1',
    OBSERVABILITY_TEST_DB_URL: `${APPROVED}?sslmode=require`,
  })
  assert.equal(r.action, 'use')
  if (r.action === 'use') {
    const u = new URL(r.url)
    assert.equal(u.searchParams.get('sslmode'), 'require')
    assert.equal(u.searchParams.get('sslaccept'), 'strict')
  }
})

test('sslaccept=accept_invalid_certs or non-strict -> stop (engine verifies only under strict, PHASE 1.67)', () => {
  for (const a of ['accept_invalid_certs', 'loose', 'bogus']) {
    const r = resolveObservabilityTestDb({
      OBSERVABILITY_TEST_DB: '1',
      OBSERVABILITY_TEST_DB_URL: `${APPROVED}?sslmode=require&sslaccept=${a}`,
    })
    assert.equal(r.action, 'stop', `sslaccept=${a} must stop`)
  }
})

test('duplicate sslaccept (any casing) -> stop', () => {
  const r = resolveObservabilityTestDb({
    OBSERVABILITY_TEST_DB: '1',
    OBSERVABILITY_TEST_DB_URL: `${APPROVED}?sslmode=require&sslaccept=strict&SSLACCEPT=strict`,
  })
  assert.equal(r.action, 'stop')
})

test('duplicate sslmode -> stop', () => {
  const r = resolveObservabilityTestDb({
    OBSERVABILITY_TEST_DB: '1',
    OBSERVABILITY_TEST_DB_URL: `${APPROVED}?sslmode=verify-full&sslmode=verify-full`,
  })
  assert.equal(r.action, 'stop')
})

test('wrong host (not on exact allowlist) -> stop, no suffix matching', () => {
  const r = resolveObservabilityTestDb({ OBSERVABILITY_TEST_DB: '1', OBSERVABILITY_TEST_DB_URL: WRONG_HOST })
  assert.equal(r.action, 'stop')
  const r2 = resolveObservabilityTestDb({
    OBSERVABILITY_TEST_DB: '1',
    OBSERVABILITY_TEST_DB_URL: `postgresql://u:p@something.${APPROVED_HOST}/pft_dbtest`,
  })
  assert.equal(r2.action, 'stop')
})

// --- PHASE 1.10.31: owner-confirmed hostname reconciliation -------------------

test('Development hostname is the ONLY approved host and is accepted (Direct, both schemes)', () => {
  assert.deepEqual(ALLOWED_TEST_DB_HOSTS, ['ep-icy-king-b4ozchkf.c-6.us-east-2.aws.neon.tech'])
  assert.equal(resolveObservabilityTestDb({ OBSERVABILITY_TEST_DB: '1', OBSERVABILITY_TEST_DB_URL: APPROVED }).action, 'use')
  assert.equal(resolveObservabilityTestDb({ OBSERVABILITY_TEST_DB: '1', OBSERVABILITY_TEST_DB_URL: APPROVED_UNPOOLED }).action, 'use')
})

test('Preview endpoint is blocked even when database name is pft_dbtest', () => {
  const r = resolveObservabilityTestDb({ OBSERVABILITY_TEST_DB: '1', OBSERVABILITY_TEST_DB_URL: PREVIEW_HOST })
  assert.equal(r.action, 'stop')
})

test('stale placeholder hostname from PHASE 1.10.30-S -> stop', () => {
  const r = resolveObservabilityTestDb({ OBSERVABILITY_TEST_DB: '1', OBSERVABILITY_TEST_DB_URL: STALE_HOST })
  assert.equal(r.action, 'stop')
})

test('Pooler hostname variant of the approved endpoint -> stop (Direct only)', () => {
  const r = resolveObservabilityTestDb({ OBSERVABILITY_TEST_DB: '1', OBSERVABILITY_TEST_DB_URL: POOLER_HOST })
  assert.equal(r.action, 'stop')
})

test('subdomains and appended suffixes of the approved hostname -> stop (exact match only)', () => {
  for (const host of [
    `a.b.${APPROVED_HOST}`, // subdomain prefixes
    `${APPROVED_HOST}.evil.com`, // trailing suffix
    `${APPROVED_HOST}x`, // appended characters
    `${APPROVED_HOST}.us-east-2.aws.neon.tech`, // duplicated suffix
  ]) {
    const r = resolveObservabilityTestDb({
      OBSERVABILITY_TEST_DB: '1',
      OBSERVABILITY_TEST_DB_URL: `postgresql://u:p@${host}/pft_dbtest`,
    })

    test('unverified endpoint and forged hostname variants are rejected', () => {
      for (const host of [
        'ep-unknown-123456.c-6.us-east-2.aws.neon.tech',
        `ep-icy-king-b4ozchkf.c-6.us-east-2.aws.neon.tech.evil.example`,
        `evil-ep-icy-king-b4ozchkf.c-6.us-east-2.aws.neon.tech`,
      ]) {
        assert.equal(
          resolveObservabilityTestDb({
            OBSERVABILITY_TEST_DB: '1',
            OBSERVABILITY_TEST_DB_URL: `postgresql://u:p@${host}/pft_dbtest`,
          }).action,
          'stop',
          host,
        )
      }
    })
    assert.equal(r.action, 'stop', `host ${host} must stop`)
  }
})

test('production host -> stop (denylist wins)', () => {
  const r = resolveObservabilityTestDb({ OBSERVABILITY_TEST_DB: '1', OBSERVABILITY_TEST_DB_URL: PROD_HOST })
  assert.equal(r.action, 'stop')
  assert.match(r.reason, /forbidden/)
})

test('wrong database name in path -> stop', () => {
  const r = resolveObservabilityTestDb({ OBSERVABILITY_TEST_DB: '1', OBSERVABILITY_TEST_DB_URL: WRONG_DB })
  assert.equal(r.action, 'stop')
})

test('legacy alias alone is fail-closed unless explicitly legacy mode', () => {
  const env = { PAYOUT_CONCURRENCY_TEST_DB: '1', PAYOUT_CONCURRENCY_TEST_DB_URL: APPROVED_UNPOOLED }
  assert.notEqual(resolveObservabilityTestDb(env).action, 'use')
  const r2 = resolveObservabilityTestDb(env, { legacy: true })
  assert.equal(r2.action, 'use')
  if (r2.action === 'use') {
    // Legacy URL is still subject to the same exact allowlist + ssl policy.
    assert.equal(new URL(r2.url).searchParams.get('sslmode'), 'require')
    assert.equal(new URL(r2.url).searchParams.get('sslaccept'), 'strict')
  }
})

test('AI Support legacy alias alone is fail-closed unless explicitly enabled', () => {
  const env = { AI_SUPPORT_TEST_DB: '1', AI_SUPPORT_TEST_DB_URL: APPROVED }
  assert.notEqual(resolveObservabilityTestDb(env).action, 'use')
  const r = resolveObservabilityTestDb(env, { legacyAiSupport: true })
  assert.equal(r.action, 'use')
  if (r.action === 'use') {
    assert.equal(new URL(r.url).pathname, '/pft_dbtest')
    assert.equal(new URL(r.url).searchParams.get('sslmode'), 'require')
    assert.equal(new URL(r.url).searchParams.get('sslaccept'), 'strict')
  }
})

test('AI Support alias is still subject to the production denylist and allowlist', () => {
  for (const url of [PROD_HOST, WRONG_HOST, WRONG_DB, `${APPROVED}?sslmode=disable`]) {
    const r = resolveObservabilityTestDb(
      { AI_SUPPORT_TEST_DB: '1', AI_SUPPORT_TEST_DB_URL: url },
      { legacyAiSupport: true },
    )
    assert.equal(r.action, 'stop', `${url} must stop`)
  }
})

test('canonical and AI Support aliases must agree on the endpoint', () => {
  const matching = resolveObservabilityTestDb(
    {
      OBSERVABILITY_TEST_DB: '1',
      OBSERVABILITY_TEST_DB_URL: APPROVED,
      AI_SUPPORT_TEST_DB: '1',
      AI_SUPPORT_TEST_DB_URL: APPROVED_UNPOOLED,
    },
    { legacyAiSupport: true },
  )
  assert.equal(matching.action, 'use')

  const divergent = resolveObservabilityTestDb(
    {
      OBSERVABILITY_TEST_DB: '1',
      OBSERVABILITY_TEST_DB_URL: APPROVED,
      AI_SUPPORT_TEST_DB: '1',
      AI_SUPPORT_TEST_DB_URL: WRONG_HOST,
    },
    { legacyAiSupport: true },
  )
  assert.equal(divergent.action, 'stop')
})

test('both pairs present with matching endpoints -> canonical URL used', () => {
  const env = {
    OBSERVABILITY_TEST_DB: '1',
    OBSERVABILITY_TEST_DB_URL: APPROVED,
    PAYOUT_CONCURRENCY_TEST_DB: '1',
    PAYOUT_CONCURRENCY_TEST_DB_URL: APPROVED_UNPOOLED,
  }
  const r = resolveObservabilityTestDb(env, { legacy: true })
  assert.equal(r.action, 'use')
  if (r.action === 'use') {
    assert.equal(new URL(r.url).protocol, 'postgresql:') // canonical scheme retained
  }
})

test('both pairs present with different endpoints -> stop', () => {
  const env = {
    OBSERVABILITY_TEST_DB: '1',
    OBSERVABILITY_TEST_DB_URL: APPROVED,
    PAYOUT_CONCURRENCY_TEST_DB: '1',
    PAYOUT_CONCURRENCY_TEST_DB_URL: WRONG_HOST,
  }
  const r = resolveObservabilityTestDb(env, { legacy: true })
  assert.equal(r.action, 'stop')
  const r2 = resolveObservabilityTestDb(env) // canonical mode also refuses divergence
  assert.equal(r2.action, 'stop')
})

test('canonical flow never falls back to DATABASE_URL', () => {
  const r = resolveObservabilityTestDb({
    OBSERVABILITY_TEST_DB: '1',
    DATABASE_URL: APPROVED, // must be ignored entirely
  })
  assert.equal(r.action, 'stop')
})

// --- reason-string hygiene ----------------------------------------------------

// --- identity wiring helper (assertClientIsTestDb) -----------------------------

type FakeClient = {
  $queryRaw: (q: TemplateStringsArray) => Promise<Array<{ db: string }>>
  $disconnect: () => Promise<unknown>
  __businessOps: number
}

/** Role-aware fake: answers current_database() and current_user() separately. */
function makeFakeClient(resolver: () => Promise<Array<{ db: string }>>, opts: { disconnectThrows?: boolean } = {}): FakeClient {
  return {
    $queryRaw: async (q: TemplateStringsArray) => {
      if (q.join('').includes('current_user')) return [{ usr: 'pft_test_runtime' }] as unknown as Array<{ db: string }>
      return resolver()
    },
    async $disconnect() {
      if (opts.disconnectThrows) throw new Error('disconnect failed')
      return
    },
    __businessOps: 0,
  }
}

test('identity wiring: correct database name -> client returned, no disconnect', async () => {
  await withRoleEnv('pft_test_runtime', async () => {
    const client = makeFakeClient(async () => [{ db: REQUIRED_TEST_DB_NAME }])
    const out = await assertClientIsTestDb(client)
    assert.equal(out, client)
  })
})

test('identity wiring: wrong database name -> STOP and disconnect', async () => {
  let disconnected = 0
  let businessOps = 0
  const client = {
    $queryRaw: async () => [{ db: 'some_other_db' }],
    $disconnect: async () => { disconnected++ },
    businessOp: async () => { businessOps++ },
  }
  await assert.rejects(() => assertClientIsTestDb(client as unknown as never), /database identity check failed/)
  assert.equal(disconnected, 1)
  assert.equal(businessOps, 0) // no business op may run after identity failure
})

test('identity wiring: identity query throws -> error propagates, client disconnected', async () => {
  let disconnected = 0
  const client = {
    $queryRaw: async () => { throw new Error('connection refused') },
    $disconnect: async () => { disconnected++ },
  }
  await assert.rejects(() => assertClientIsTestDb(client as unknown as never), /connection refused/)
  assert.equal(disconnected, 1)
})

test('identity wiring: disconnect failure does not mask identity error', async () => {
  const client = makeFakeClient(async () => [{ db: 'wrong' }], { disconnectThrows: true })
  await assert.rejects(() => assertClientIsTestDb(client), /database identity check failed/)
})

test('identity wiring: two independent clients -> two separate identity checks', async () => {
  await withRoleEnv('pft_test_runtime', async () => {
    let checks = 0
    const resolver = async () => { checks++; return [{ db: REQUIRED_TEST_DB_NAME }] }
    const a = await assertClientIsTestDb(makeFakeClient(resolver))
    const b = await assertClientIsTestDb(makeFakeClient(resolver))
    assert.equal(checks, 2)
    assert.notEqual(a, b)
  })
})

test('identity wiring: one client passes, second fails -> second performs no business ops', async () => {
  await withRoleEnv('pft_test_runtime', async () => {
    const good = await assertClientIsTestDb(makeFakeClient(async () => [{ db: REQUIRED_TEST_DB_NAME }]))
    assert.equal(good.__businessOps, 0) // no business op happened during wiring
    const bad = makeFakeClient(async () => [{ db: 'not_the_test_db' }])
    await assert.rejects(() => assertClientIsTestDb(bad), /database identity check failed/)
    assert.equal(bad.__businessOps, 0) // static: throw blocks any continuation
  })
})

// --- PHASE 1.16: optional role pinning via TEST_DB_EXPECTED_ROLE ---------------

/** Fake client that answers differently for current_database() vs current_user(). */
function makeRoleAwareClient(db: string, usr: string): {
  $queryRaw: (q: TemplateStringsArray) => Promise<Array<Record<string, unknown>>>
  $disconnect: () => Promise<unknown>
} {
  return {
    $queryRaw: async (q: TemplateStringsArray) => {
      const sql = q.join('')
      if (sql.includes('current_user')) return [{ usr }]
      return [{ db }]
    },
    async $disconnect() {
      return
    },
  }
}

function withRoleEnv(role: string | undefined, fn: () => Promise<void>): Promise<void> {
  const saved = process.env.TEST_DB_EXPECTED_ROLE
  const mutableEnv = process.env as Record<string, unknown>
  if (role === undefined) delete mutableEnv.TEST_DB_EXPECTED_ROLE
  else mutableEnv.TEST_DB_EXPECTED_ROLE = role
  return fn().finally(() => {
    if (saved === undefined) delete mutableEnv.TEST_DB_EXPECTED_ROLE
    else mutableEnv.TEST_DB_EXPECTED_ROLE = saved
  })
}

test('role pinning: PHASE 1.18 MANDATORY — missing TEST_DB_EXPECTED_ROLE -> STOP, no silent disable', async () => {
  await withRoleEnv(undefined, async () => {
    await assert.rejects(
      () => assertClientIsTestDb(makeFakeClient(async () => [{ db: REQUIRED_TEST_DB_NAME }])),
      /database role check failed: TEST_DB_EXPECTED_ROLE is not set/,
    )
    // even a client under an unexpected role aborts (missing config never disables the check)
    await assert.rejects(
      () => assertClientIsTestDb(makeRoleAwareClient(REQUIRED_TEST_DB_NAME, 'unexpected_role')),
      /TEST_DB_EXPECTED_ROLE is not set/,
    )
  })
})

test('role pinning: correct role -> passes', async () => {
  await withRoleEnv('pft_test_runtime', async () => {
    await assertClientIsTestDb(makeRoleAwareClient(REQUIRED_TEST_DB_NAME, 'pft_test_runtime'))
  })
})

test('role pinning: wrong role -> STOP, error mentions role check and no credentials', async () => {
  await withRoleEnv('pft_test_runtime', async () => {
    let disconnected = 0
    const client = makeRoleAwareClient(REQUIRED_TEST_DB_NAME, 'neondb_owner')
    const wrapped = { ...client, $disconnect: async () => { disconnected++ } }
    await assert.rejects(
      () => assertClientIsTestDb(wrapped as unknown as never),
      /database role check failed: current_user is 'neondb_owner', expected 'pft_test_runtime'/,
    )
    assert.equal(disconnected, 1)
  })
})

test('role pinning: empty/whitespace TEST_DB_EXPECTED_ROLE is a configuration error -> STOP', async () => {
  await withRoleEnv('   ', async () => {
    await assert.rejects(
      () => assertClientIsTestDb(makeRoleAwareClient(REQUIRED_TEST_DB_NAME, 'any_role')),
      /TEST_DB_EXPECTED_ROLE is not set/,
    )
  })
})

test('identity wiring: error messages never contain URLs or credentials', async () => {  try {
    await assertClientIsTestDb(makeFakeClient(async () => [{ db: 'prod' }]))
    assert.fail('must throw')
  } catch (e) {
    const msg = String((e as Error).message)
    assert.ok(!msg.includes('postgres'))
    assert.ok(!msg.includes('neon'))
    assert.ok(!msg.includes('password'))
  }
})

test('skip/stop reasons never contain host, URL or credentials', () => {
  const envs = [
    { OBSERVABILITY_TEST_DB: '1', OBSERVABILITY_TEST_DB_URL: PROD_HOST },
    { OBSERVABILITY_TEST_DB: '1', OBSERVABILITY_TEST_DB_URL: WRONG_DB },
    { OBSERVABILITY_TEST_DB: '1', OBSERVABILITY_TEST_DB_URL: `${APPROVED}?sslmode=require` },
    { OBSERVABILITY_TEST_DB: '1' },
    {},
  ]
  for (const env of envs) {
    const r = resolveObservabilityTestDb(env)
    if (r.action === 'use') continue
    assert.ok(r.reason.length > 0)
    assert.ok(!('url' in r))
    // Reasons are static sentences — assert no URL fragments leak.
    for (const fragment of ['/pft_dbtest', 'neon.tech', 'postgres://', 'docuser', 'docpass']) {
      assert.ok(!r.reason.includes(fragment), `reason leaked ${fragment}: ${r.reason}`)
    }
  }
})

// ================= PHASE 1.45: hard role pin =================

test('role pin: REQUIRED_TEST_DB_ROLE/REQUIRED_TEST_DB_PORT are the only permitted values', () => {
  assert.equal(REQUIRED_TEST_DB_ROLE, 'pft_test_runtime')
  assert.equal(REQUIRED_TEST_DB_PORT, '5432')
})

for (const forbidden of ['neondb_owner', 'pft_test_init', 'neon_superuser', 'PFT_TEST_RUNTIME']) {
  test(`role pin: TEST_DB_EXPECTED_ROLE cannot override policy -> ${forbidden} fails`, async () => {
    await withRoleEnv(forbidden, async () => {
      await assert.rejects(
        () => assertClientIsTestDb(makeRoleAwareClient(REQUIRED_TEST_DB_NAME, 'pft_test_runtime')),
        /hard-pinned/,
      )
    })
  })
}

test('role pin: padded valid role value is trimmed and accepted', async () => {
  await withRoleEnv('  pft_test_runtime  ', async () => {
    await assertClientIsTestDb(makeRoleAwareClient(REQUIRED_TEST_DB_NAME, 'pft_test_runtime'))
  })
})

test('role pin: current_user must equal the constant (pft_test_init rejected even when env matches)', async () => {
  await withRoleEnv('pft_test_runtime', async () => {
    await assert.rejects(
      () => assertClientIsTestDb(makeRoleAwareClient(REQUIRED_TEST_DB_NAME, 'pft_test_init')),
      /database role check failed/,
    )
  })
})

test('STOP is not silently skipped: assertGateAllowsExecution throws on stop only', () => {
  assert.throws(() => assertGateAllowsExecution({ action: 'stop', reason: 'x' }), /gate STOPPED/)
  assert.doesNotThrow(() => assertGateAllowsExecution({ action: 'skip', reason: 'x' }))
  assert.doesNotThrow(() => assertGateAllowsExecution({ action: 'use', url: 'postgresql://u:p@h/db' }))
})

// ================= PHASE 1.45: case-insensitive query params + port pin =================

const gateUse = (url: string) => resolveObservabilityTestDb({ OBSERVABILITY_TEST_DB: '1', OBSERVABILITY_TEST_DB_URL: url })

test('query params: SSLMODE (uppercase key) with a downgrade value -> STOP', () => {
  assert.equal(gateUse(`${APPROVED}?SSLMODE=disable`).action, 'stop')
})
test('query params: SslMode (mixed case key) with disable -> STOP', () => {
  assert.equal(gateUse(`${APPROVED}?SslMode=disable`).action, 'stop')
})
test('query params: mixed-case duplicate sslmode -> STOP (ambiguous)', () => {
  assert.equal(gateUse(`${APPROVED}?sslmode=require&SSLMODE=disable`).action, 'stop')
})
test('query params: percent-encoded sslmode key is decoded and checked -> STOP', () => {
  assert.equal(gateUse(`${APPROVED}?%73slmode=disable`).action, 'stop')
})
test('query params: percent-encoded legacy verify-full value is accepted and canonicalized (PHASE 1.67)', () => {
  const r = gateUse(`${APPROVED}?sslmode=verify%2Dfull`)
  assert.equal(r.action, 'use')
  if (r.action === 'use') {
    const u = new URL(r.url)
    assert.equal(u.searchParams.getAll('sslmode').length, 1)
    assert.equal(u.searchParams.get('sslmode'), 'require')
    assert.equal(u.searchParams.get('sslaccept'), 'strict')
  }
})
test('query params: UPPERCASE VERIFY-FULL value is canonicalized to exactly one lowercase require+strict (PHASE 1.67)', () => {
  const r = gateUse(`${APPROVED}?SSLMODE=VERIFY-FULL`)
  assert.equal(r.action, 'use')
  if (r.action === 'use') {
    const u = new URL(r.url)
    assert.equal(u.searchParams.getAll('sslmode').length, 1)
    assert.equal(u.searchParams.get('sslmode'), 'require')
    assert.equal(u.searchParams.get('sslaccept'), 'strict')
  }
})
test('query params: percent-encoded sslaccept value is decoded and checked -> STOP', () => {
  assert.equal(gateUse(`${APPROVED}?sslmode=require&%73slaccept=accept_invalid_certs`).action, 'stop')
})
test('query params: SSLACCEPT uppercase key canonicalized; duplicate lowercase key -> STOP', () => {
  assert.equal(gateUse(`${APPROVED}?SSLACCEPT=STRICT`).action, 'use')
  assert.equal(gateUse(`${APPROVED}?SSLACCEPT=STRICT&sslaccept=strict`).action, 'stop')
})
test('query params: forbidden connection parameters (host/port/dbname/service/options/sslrootcert) -> STOP', () => {
  for (const q of ['host=evil.example', 'port=6543', 'dbname=neondb', 'service=prod', 'options=-csearch_path%3Devil', 'sslrootcert=/tmp/x']) {
    assert.equal(gateUse(`${APPROVED}?${q}`).action, 'stop', `expected STOP for ?${q}`)
  }
})

test('port: explicit 5432 accepted and serialized', () => {
  const r = gateUse(`postgresql://docuser:docpass@${APPROVED_HOST}:5432/pft_dbtest`)
  assert.equal(r.action, 'use')
  if (r.action === 'use') assert.equal(new URL(r.url).port, '5432')
})
test('port: omitted port defaults to pinned 5432 in the serialized URL', () => {
  const r = gateUse(APPROVED)
  assert.equal(r.action, 'use')
  if (r.action === 'use') assert.equal(new URL(r.url).port, '5432')
})
test('port: 6543 -> STOP', () => {
  assert.equal(gateUse(`postgresql://docuser:docpass@${APPROVED_HOST}:6543/pft_dbtest`).action, 'stop')
})
test('port: invalid port -> STOP (URL parse failure, no crash)', () => {
  assert.equal(gateUse(`postgresql://docuser:docpass@${APPROVED_HOST}:999999/pft_dbtest`).action, 'stop')
})

// ================= PHASE 1.45: launcher + payout cleanup static assertions =================

type PackageJson = { scripts: Record<string, string> }
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageJson

test('launcher: test:db:gated runs the deterministic runner (PHASE 1.48)', () => {
  const cmd = pkg.scripts['test:db:gated']
  assert.ok(cmd.includes('scripts/db-gated-runner.cjs'), cmd)
})

test('launcher: runner pins --test-concurrency=1 and exactly the three gated DB suites', () => {
  const runner = readFileSync(new URL('./db-gated-runner.cjs', import.meta.url), 'utf8')
  assert.ok(runner.includes("'--test-concurrency=1'"))
  for (const f of ['scripts/gated/auth-login-db.test.ts', 'scripts/gated/rate-limit-store-db.test.ts', 'scripts/payout-concurrency.test.ts']) {
    assert.ok(runner.includes(f), `missing ${f}`)
  }
})

test('launcher: runner generates/validates ONE TEST_RUN_ID and passes it to every suite', () => {
  const runner = readFileSync(new URL('./db-gated-runner.cjs', import.meta.url), 'utf8')
  assert.ok(runner.includes('TEST_RUN_ID'))
  assert.ok(runner.includes('RUN_ID_PATTERN'))
  assert.ok(runner.includes('TEST_RUN_ID: runId'))
  assert.ok(runner.includes('buildRunStarted'))
  assert.ok(runner.includes('buildRunCompleted'))
  assert.ok(runner.includes('appendEvent'))
})

test('launcher: other test scripts keep their original concurrency (no scoped change)', () => {
  assert.ok(!pkg.scripts['test:observability'].includes('--test-concurrency'))
  assert.ok(!pkg.scripts['test:ai-support'].includes('--test-concurrency'))
})

test('payout cleanup: every extra client closes via safeClose/extraClients in finally', () => {
  const src = readFileSync(new URL('./payout-concurrency.test.ts', import.meta.url), 'utf8')
  assert.ok(src.includes('async function safeClose'))
  assert.ok(src.includes('async function safeRowCleanup'))
  assert.ok(src.includes("await safeClose(a, 'a')"))
  assert.ok(src.includes("await safeClose(b, 'b')"))
  assert.ok(src.includes('for (const c of extraClients) await safeClose(c, c.__label)'))
  assert.ok(src.includes('await safeRowCleanup(setup, h)'))
  // no naked per-test disconnects remain outside the safeClose helper
  assert.ok(!/await (a|b|r1|r2|c1|c2|c3|c4|b1|b2)\.\$disconnect\(\)/.test(src))
  assert.ok(!src.includes('await cleanup(setup, h)'))
})
test('payout cleanup: safeClose never throws and logs separately (source proof)', () => {
  const src = readFileSync(new URL('./payout-concurrency.test.ts', import.meta.url), 'utf8')
  const start = src.indexOf('async function safeClose')
  assert.ok(start >= 0)
  const body = src.slice(start, src.indexOf('async function safeRowCleanup'))
  assert.ok(body.includes('try {'))
  assert.ok(body.includes('catch (error)'))
  assert.ok(body.includes('console.error'))
})
