import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  canRunDiagnostics,
  claimDiagnosticsSlot,
  endpointHostname,
  probeNvidia,
} from '../lib/ai/nvidia-probe'
import { NVIDIA_DEFAULT_MODEL } from '../lib/ai/nvidia'
import {
  classifyDatabaseIdentity,
  readRuntimeDatabaseName,
} from '../lib/ops/database-identity'
import { assertSameOrigin } from '../lib/security/csrf'

/**
 * PHASE 1.10.41 — owner-only diagnostics.
 * Fully offline: no provider call, no database connection, no writes.
 */

const TEST_KEY = 'pft-test-key-not-real'
const APPROVED_HOST = 'ep-icy-king-b4ozchkf.c-6.us-east-2.aws.neon.tech'

type EnvSnapshot = Record<string, string | undefined>
const NAMES = ['NVIDIA_API_KEY', 'NVIDIA_MODEL', 'NVIDIA_BASE_URL', 'AI_PROVIDER'] as const

function withEnv<T>(values: Partial<Record<(typeof NAMES)[number], string | undefined>>, run: () => Promise<T>): Promise<T> {
  const previous: EnvSnapshot = {}
  for (const name of NAMES) previous[name] = process.env[name]
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  return run().finally(() => {
    for (const name of NAMES) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name] as string
    }
  })
}

function completion(content: string, finish = 'stop') {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: NVIDIA_DEFAULT_MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
  }
}

function stubFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
}

const VALID_CONTENT = JSON.stringify({
  answer: 'ok',
  resolved: true,
  category: 'GENERAL',
  handoffReason: '',
})

const nvidiaEnv = { NVIDIA_API_KEY: TEST_KEY, NVIDIA_BASE_URL: 'https://integrate.api.nvidia.com/v1', NVIDIA_MODEL: undefined, AI_PROVIDER: undefined }

test('nvidia probe passes on a valid synthetic response', async () => {
  await withEnv(nvidiaEnv, async () => {
    const result = await probeNvidia({ fetchImpl: stubFetch(completion(VALID_CONTENT)) })
    assert.equal(result.ok, true)
    assert.equal(result.provider, 'nvidia')
    assert.equal(result.httpStatus, 200)
    assert.equal(result.schemaValid, true)
    assert.equal(result.endpointHost, 'integrate.api.nvidia.com')
    assert.equal(result.error, null)
    assert.ok(result.latencyMs >= 0)
  })
})

test('nvidia probe classifies 401 as missing_key', async () => {
  await withEnv(nvidiaEnv, async () => {
    const result = await probeNvidia({ fetchImpl: stubFetch({ detail: 'invalid api key' }, 401) })
    assert.equal(result.ok, false)
    assert.equal(result.error?.category, 'missing_key')
    assert.equal(result.error?.status, 401)
  })
})

test('nvidia probe classifies 429 and 5xx', async () => {
  await withEnv(nvidiaEnv, async () => {
    const limited = await probeNvidia({
      fetchImpl: stubFetch({ type: 'too-many-requests', detail: 'Rate limit exceeded, retry later' }, 429),
    })
    assert.equal(limited.error?.category, 'rate_limited')
    assert.equal(limited.error?.status, 429)

    const server = await probeNvidia({ fetchImpl: stubFetch({ detail: 'internal error' }, 500) })
    assert.equal(server.error?.category, 'unavailable')
    assert.equal(server.error?.status, 500)
  })
})

test('nvidia probe classifies timeout', async () => {
  await withEnv(nvidiaEnv, async () => {
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })) as unknown as typeof fetch

    const result = await probeNvidia({ fetchImpl: hanging, timeoutMs: 30 })
    assert.equal(result.ok, false)
    assert.equal(result.error?.category, 'timeout')
  })
})

test('nvidia probe flags malformed JSON as malformed_response', async () => {
  await withEnv(nvidiaEnv, async () => {
    const result = await probeNvidia({ fetchImpl: stubFetch(completion('not json at all')) })
    assert.equal(result.ok, false)
    assert.equal(result.httpStatus, 200)
    assert.equal(result.schemaValid, false)
    assert.equal(result.error?.category, 'malformed_response')
  })
})

test('nvidia probe stops before any request when credentials are missing', async () => {
  await withEnv({ ...nvidiaEnv, NVIDIA_API_KEY: undefined, AI_PROVIDER: 'nvidia' }, async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      throw new Error('must not be called')
    }) as unknown as typeof fetch
    const result = await probeNvidia({ fetchImpl })
    assert.equal(result.ok, false)
    assert.equal(result.error?.category, 'missing_key')
    assert.equal(called, false)
  })
})

test('nvidia probe refuses to run when the provider is not NVIDIA', async () => {
  await withEnv({ ...nvidiaEnv, AI_PROVIDER: 'gemini' }, async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      throw new Error('must not be called')
    }) as unknown as typeof fetch
    const result = await probeNvidia({ fetchImpl })
    assert.equal(result.error?.category, 'provider_not_nvidia')
    assert.equal(called, false)
  })
})

test('endpoint hostname never includes path or credentials', () => {
  assert.equal(endpointHostname('https://user:pass@example.com:8443/v1?x=1'), 'example.com')
  assert.equal(endpointHostname('not a url'), null)
})

test('diagnostics access and cooldown are ADMIN-only and cheap', () => {
  assert.equal(canRunDiagnostics('ADMIN'), true)
  for (const role of ['SUPPORT', 'RISK_MANAGER', 'TRADER', null, undefined, 'admin']) {
    assert.equal(canRunDiagnostics(role), false, String(role))
  }
  assert.equal(claimDiagnosticsSlot('actor-1', 'nvidia', 1_000, 3_000), true)
  assert.equal(claimDiagnosticsSlot('actor-1', 'nvidia', 2_000, 3_000), false)
  assert.equal(claimDiagnosticsSlot('actor-1', 'database', 2_000, 3_000), true)
  assert.equal(claimDiagnosticsSlot('actor-2', 'nvidia', 2_000, 3_000), true)
  assert.equal(claimDiagnosticsSlot('actor-1', 'nvidia', 5_000, 3_000), true)
})

test('database identity: approved host + live confirmation is TEST', () => {
  const report = classifyDatabaseIdentity({
    url: `postgresql://u:p@${APPROVED_HOST}:5432/pft_dbtest?sslmode=verify-full`,
    env: { VERCEL_ENV: 'preview' },
    runtimeDatabaseName: 'pft_dbtest',
  })
  assert.equal(report.status, 'TEST')
  assert.equal(report.hostname, APPROVED_HOST)
  assert.equal(report.databaseName, 'pft_dbtest')
  assert.equal(report.isApprovedTestDatabase, true)
  assert.equal(report.isProductionDatabase, false)
  assert.equal(report.identityVerified, true)
})

test('database identity: approved host without live confirmation is BLOCKED', () => {
  const report = classifyDatabaseIdentity({
    url: `postgresql://u:p@${APPROVED_HOST}/pft_dbtest`,
    env: { VERCEL_ENV: 'preview' },
    runtimeDatabaseName: null,
  })
  assert.equal(report.status, 'BLOCKED')
  assert.equal(report.isApprovedTestDatabase, true)
  assert.equal(report.identityVerified, false)
})

test('database identity: unknown host is never approved', () => {
  const report = classifyDatabaseIdentity({
    url: 'postgresql://u:p@ep-unknown-123.us-east-2.aws.neon.tech/pft_dbtest',
    env: { VERCEL_ENV: 'preview' },
    runtimeDatabaseName: 'pft_dbtest',
  })
  assert.equal(report.status, 'BLOCKED')
  assert.equal(report.isApprovedTestDatabase, false)
  assert.equal(report.identityVerified, false)
})

test('database identity: production classifications are fail-closed', () => {
  const forbidden = classifyDatabaseIdentity({
    url: 'postgresql://u:p@ep-jolly-resonance-b4oprbt2-pooler.us-east-2.aws.neon.tech/neondb',
    env: { VERCEL_ENV: 'preview' },
    runtimeDatabaseName: 'neondb',
  })
  assert.equal(forbidden.status, 'PRODUCTION')
  assert.equal(forbidden.isProductionDatabase, true)

  const prodEnv = classifyDatabaseIdentity({
    url: `postgresql://u:p@${APPROVED_HOST}/pft_dbtest`,
    env: { VERCEL_ENV: 'production' },
    runtimeDatabaseName: 'pft_dbtest',
  })
  assert.equal(prodEnv.status, 'PRODUCTION')

  const prodName = classifyDatabaseIdentity({
    url: 'postgresql://u:p@db.internal/pft_prod',
    env: { VERCEL_ENV: 'preview' },
  })
  assert.equal(prodName.status, 'PRODUCTION')
})

test('database identity: missing URL or runtime mismatch is BLOCKED', () => {
  assert.equal(classifyDatabaseIdentity({ url: null }).status, 'BLOCKED')
  const mismatch = classifyDatabaseIdentity({
    url: `postgresql://u:p@${APPROVED_HOST}/pft_dbtest`,
    env: { VERCEL_ENV: 'preview' },
    runtimeDatabaseName: 'neondb',
  })
  assert.equal(mismatch.status, 'BLOCKED')
  assert.equal(mismatch.identityVerified, false)
})

test('read-only identity query returns the live database name', async () => {
  const client = { $queryRaw: async () => [{ db: 'pft_dbtest' }] }
  assert.equal(await readRuntimeDatabaseName(client), 'pft_dbtest')
})

test('read-only identity query times out without writing', async () => {
  const client = { $queryRaw: () => new Promise<never>(() => {}) }
  await assert.rejects(() => readRuntimeDatabaseName(client, 20))
})

test('CSRF guard rejects cross-origin POST diagnostics and allows same-origin', () => {
  const url = 'https://preview.example.com/api/admin/diagnostics/nvidia'
  const crossSite = new Request(url, { method: 'POST', headers: { origin: 'https://evil.example' } })
  const sameOrigin = new Request(url, { method: 'POST', headers: { origin: 'https://preview.example.com' } })
  const noOrigin = new Request(url, { method: 'POST' })
  const getWithOrigin = new Request(url, { method: 'GET', headers: { origin: 'https://evil.example' } })

  assert.equal(assertSameOrigin(crossSite)?.status, 403)
  assert.equal(assertSameOrigin(sameOrigin), null)
  assert.equal(assertSameOrigin(noOrigin), null)
  assert.equal(assertSameOrigin(getWithOrigin), null)
})

test('diagnostics modules cannot import the Support service or write to the database', () => {
  const root = process.cwd()
  const probe = fs.readFileSync(path.join(root, 'lib/ai/nvidia-probe.ts'), 'utf8')
  const imports = probe
    .split(/\r?\n/)
    .filter((line) => /^\s*(import|const .*require\()/.test(line))
    .join('\n')
  assert.ok(
    !/support\/service|support-chat|@\/lib\/prisma|PrismaClient|nvidia-probe.*service/i.test(imports),
    'probe must stay DB-free',
  )

  const dbRoute = fs.readFileSync(path.join(root, 'app/api/admin/diagnostics/database/route.ts'), 'utf8')
  assert.ok(!/\$executeRaw|\.create\(|\.update\(|\.delete\(|\.upsert\(/i.test(dbRoute), 'no write operations allowed')
  const identityLib = fs.readFileSync(path.join(root, 'lib/ops/database-identity.ts'), 'utf8')
  assert.ok(identityLib.includes('SELECT current_database()'), 'identity must use a read-only SELECT')
  assert.ok(!/\$executeRaw|\.create\(|\.update\(|\.delete\(|\.upsert\(/i.test(identityLib), 'identity must never write')
})
