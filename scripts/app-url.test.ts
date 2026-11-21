/**
 * App URL resolution tests (environment separation, fail-closed preview).
 * No DB, no network: pure process.env behavior.
 * Run: node --import tsx --test scripts/app-url.test.ts
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const ENV_KEYS = ['NEXT_PUBLIC_APP_URL', 'VERCEL_URL', 'VERCEL_ENV', 'NODE_ENV'] as const

function withEnv(env: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const)
  const mutableEnv = process.env as Record<string, unknown>
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete mutableEnv[k]
    else mutableEnv[k] = v
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of saved) {
        if (v === undefined) delete mutableEnv[k]
        else mutableEnv[k] = v
      }
    })
}

describe('appUrl resolution', () => {
  test('1. explicit NEXT_PUBLIC_APP_URL wins in every scope and trailing slashes are stripped', async () => {
    const { appUrl } = await import('../lib/app-url')
    await withEnv({ NEXT_PUBLIC_APP_URL: 'https://custom.example.com/', VERCEL_URL: 'preview-abc.vercel.app', VERCEL_ENV: 'preview' }, async () => {
      assert.equal(appUrl(), 'https://custom.example.com')
    })
    await withEnv({ NEXT_PUBLIC_APP_URL: 'https://custom.example.com///', VERCEL_URL: undefined, VERCEL_ENV: 'production' }, async () => {
      assert.equal(appUrl(), 'https://custom.example.com')
    })
  })

  test('2. preview deployment without NEXT_PUBLIC_APP_URL uses its own VERCEL_URL (https)', async () => {
    const { appUrl } = await import('../lib/app-url')
    await withEnv({ NEXT_PUBLIC_APP_URL: undefined, VERCEL_URL: 'pft-app-git-fix-abc123.vercel.app', VERCEL_ENV: 'preview', NODE_ENV: undefined }, async () => {
      assert.equal(appUrl(), 'https://pft-app-git-fix-abc123.vercel.app')
    })
  })

  test('3. preview with EMPTY NEXT_PUBLIC_APP_URL also falls back to VERCEL_URL', async () => {
    const { appUrl } = await import('../lib/app-url')
    await withEnv({ NEXT_PUBLIC_APP_URL: '', VERCEL_URL: 'preview-abc.vercel.app', VERCEL_ENV: 'preview', NODE_ENV: undefined }, async () => {
      assert.equal(appUrl(), 'https://preview-abc.vercel.app')
    })
  })

  test('4. FAIL-CLOSED: preview without NEXT_PUBLIC_APP_URL and VERCEL_URL throws instead of emitting production links', async () => {
    const { appUrl } = await import('../lib/app-url')
    await withEnv({ NEXT_PUBLIC_APP_URL: undefined, VERCEL_URL: undefined, VERCEL_ENV: 'preview', NODE_ENV: undefined }, async () => {
      assert.throws(() => appUrl(), /Preview app URL cannot be determined/)
    })
    // Empty-string VERCEL_URL must behave exactly like a missing one.
    await withEnv({ NEXT_PUBLIC_APP_URL: '', VERCEL_URL: '', VERCEL_ENV: 'preview', NODE_ENV: undefined }, async () => {
      assert.throws(() => appUrl(), /Preview app URL cannot be determined/)
    })
  })

  test('5. production runtime ignores VERCEL_URL (no preview leak into production)', async () => {
    const { appUrl } = await import('../lib/app-url')
    await withEnv({ NEXT_PUBLIC_APP_URL: undefined, VERCEL_URL: 'preview-abc.vercel.app', VERCEL_ENV: 'production' }, async () => {
      assert.equal(appUrl(), 'https://pft-app-prod.vercel.app')
    })
    await withEnv({ NEXT_PUBLIC_APP_URL: undefined, VERCEL_URL: 'preview-abc.vercel.app', VERCEL_ENV: undefined, NODE_ENV: 'production' }, async () => {
      assert.equal(appUrl(), 'https://pft-app-prod.vercel.app')
    })
  })

  test('6. no configuration and unknown runtime -> canonical production URL', async () => {
    const { appUrl } = await import('../lib/app-url')
    await withEnv({ NEXT_PUBLIC_APP_URL: undefined, VERCEL_URL: undefined, VERCEL_ENV: undefined, NODE_ENV: undefined }, async () => {
      assert.equal(appUrl(), 'https://pft-app-prod.vercel.app')
    })
  })

  test('7. development runtime gets the safe local default, never the production domain', async () => {
    const { appUrl } = await import('../lib/app-url')
    await withEnv({ NEXT_PUBLIC_APP_URL: undefined, VERCEL_URL: undefined, VERCEL_ENV: undefined, NODE_ENV: 'development' }, async () => {
      assert.equal(appUrl(), 'http://localhost:3000')
    })
    // vercel dev sets VERCEL_ENV=development.
    await withEnv({ NEXT_PUBLIC_APP_URL: undefined, VERCEL_URL: undefined, VERCEL_ENV: 'development', NODE_ENV: undefined }, async () => {
      assert.equal(appUrl(), 'http://localhost:3000')
    })
    // Explicit local configuration keeps working (dotenv-quoted value included).
    await withEnv({ NEXT_PUBLIC_APP_URL: '"http://localhost:3000"', VERCEL_URL: undefined, VERCEL_ENV: undefined, NODE_ENV: 'development' }, async () => {
      assert.equal(appUrl(), 'http://localhost:3000')
    })
  })

  test('8. FAIL-CLOSED: scheme-less or malformed configured value throws instead of building broken links', async () => {
    const { appUrl } = await import('../lib/app-url')
    for (const bad of ['pft-app-prod.vercel.app', 'ftp://host.example.com', '"http://localhost:3000" trailing-quote']) {
      await withEnv({ NEXT_PUBLIC_APP_URL: bad, VERCEL_URL: undefined, VERCEL_ENV: undefined, NODE_ENV: undefined }, async () => {
        assert.throws(() => appUrl(), /NEXT_PUBLIC_APP_URL is not a valid/)
      })
    }
    // Quote-wrapped-but-empty value is treated as unset -> normal fallback.
    await withEnv({ NEXT_PUBLIC_APP_URL: '"  "', VERCEL_URL: undefined, VERCEL_ENV: undefined, NODE_ENV: undefined }, async () => {
      assert.equal(appUrl(), 'https://pft-app-prod.vercel.app')
    })
  })

  test('9. delegates are wired: credentials email, password reset and certificates use the shared appUrl()', () => {
    const credentials = readFileSync('lib/email/account-credentials.ts', 'utf8')
    assert.doesNotMatch(credentials, /DEFAULT_APP_URL/)
    assert.match(credentials, /from '@\/lib\/app-url'/)
    const render = readFileSync('lib/certificates/render.ts', 'utf8')
    assert.doesNotMatch(render, /DEFAULT_APP_URL/)
    assert.match(render, /from '@\/lib\/app-url'/)
    const reset = readFileSync('lib/email/password-reset.ts', 'utf8')
    assert.match(reset, /appUrl/)
  })
})
