import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { isActiveTraderUser } from '../lib/trader/session-policy'
import { resolveSafeNextPath } from '../lib/auth/safe-next-path'

/**
 * Authentication policy regressions (no database).
 *
 * Pins the rule that archived traders can never sign in or keep a session,
 * including the Google OAuth path that previously checked only the role.
 */

test('archived traders are never considered active, regardless of role field', () => {
  assert.equal(isActiveTraderUser({ role: 'TRADER', archivedAt: new Date() }), false)
  assert.equal(isActiveTraderUser({ role: 'TRADER', archivedAt: null }), true)
  assert.equal(isActiveTraderUser({ role: 'ADMIN', archivedAt: null }), false)
  assert.equal(isActiveTraderUser(null), false)
  assert.equal(isActiveTraderUser(undefined), false)
})

test('post-login redirects stay on the current origin', () => {
  const base = 'https://app.pft.example/login'
  for (const hostile of [
    'https://evil.example/dashboard',
    '//evil.example/dashboard',
    '/\\evil.example/dashboard',
    '/\tevil',
    'javascript:alert(1)',
  ]) {
    assert.equal(resolveSafeNextPath(hostile, base), '/dashboard', `must reject ${JSON.stringify(hostile)}`)
  }
  assert.equal(resolveSafeNextPath('/dashboard/payouts?tab=open#top', base), '/dashboard/payouts?tab=open#top')
  assert.equal(resolveSafeNextPath(null, base), '/dashboard')
})

test('email-sending auth routes keep a per-IP throttle in front of the provider', () => {
  const routes = [
    ['app/api/auth/email-code/route.ts', 'email-code-ip:'],
    ['app/api/auth/forgot-password/route.ts', 'forgot-ip:'],
  ] as const
  for (const [file, keyPrefix] of routes) {
    const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8')
    assert.match(source, /clientIp\(request\)/, `${file} must derive the trusted client IP`)
    assert.ok(source.includes(keyPrefix), `${file} must use an IP-scoped rate-limit key (${keyPrefix})`)
    assert.match(source, /isRateLimited\(/, `${file} must call the durable limiter`)
  }
})
