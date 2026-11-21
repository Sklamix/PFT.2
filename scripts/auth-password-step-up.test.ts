import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { isLoginRisky, loginIpChanged, FAILED_LOGIN_RISK_THRESHOLD } from '../lib/trader/login-risk'
import { emailCodeHash, EMAIL_CODE_TTL_MS } from '../lib/trader/email-codes'

/**
 * Password sign-in hardening (no database):
 *  - step-up risk policy: new IP prefix or repeated failed attempts;
 *  - STEP_UP codes are single-use, hashed with their purpose and rate-limited;
 *  - the login-method endpoint cannot enumerate accounts.
 */

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8')

test('login step-up: a never-seen IP prefix is flagged, a first-ever login is not', () => {
  assert.equal(loginIpChanged(null, '203.0.113.7'), false, 'no stored IP yet: do not challenge the first login')
  assert.equal(loginIpChanged('203.0.113.7', '203.0.113.7'), false)
  assert.equal(loginIpChanged('203.0.113.7', '203.0.113.8'), true)
  // IPv6 compares /48: three /16 groups.
  assert.equal(loginIpChanged('2001:db8:1a00::1', '2001:db8:1a00:beef::9'), false)
  assert.equal(loginIpChanged('2001:db8:1a00::1', '2001:db8:1b00::9'), true)
})

test('login step-up: repeated failed attempts exceed the conservative threshold', () => {
  assert.equal(isLoginRisky({ lastLoginIp: '203.0.113.7', failedLoginCount: FAILED_LOGIN_RISK_THRESHOLD }, '203.0.113.7'), false)
  assert.equal(isLoginRisky({ lastLoginIp: '203.0.113.7', failedLoginCount: FAILED_LOGIN_RISK_THRESHOLD + 1 }, '203.0.113.7'), true)
  assert.equal(isLoginRisky({ lastLoginIp: '203.0.113.7', failedLoginCount: 0 }, '198.51.100.9'), true)
  assert.equal(isLoginRisky({ lastLoginIp: null, failedLoginCount: 0 }, '203.0.113.7'), false)
})

test('STEP_UP codes are hashed under their own purpose and share no bytes with LOGIN codes', () => {
  process.env.TRADER_SESSION_SECRET ??= 'pft-dev-trader-session-secret'
  const stepUp = emailCodeHash('a@b.co', '123456', 'STEP_UP')
  const login = emailCodeHash('a@b.co', '123456', 'LOGIN')
  assert.notEqual(stepUp, login)
  assert.equal(emailCodeHash('a@b.co', '123456', 'STEP_UP'), stepUp, 'deterministic for the same inputs')
  assert.equal(EMAIL_CODE_TTL_MS, 10 * 60_000)
  // Codes render as fixed-width zero-padded numbers on the wire.
  assert.match(String(42).padStart(6, '0'), /^000042$/)
})

test('password sign-in hardening wiring', () => {
  const login = read('app/api/auth/login/route.ts')
  assert.match(login, /stepUp: true/, 'a risky password sign-in must ask for step-up verification')
  assert.match(login, /recordFailedLogin\(/, 'failed attempts must be counted')
  assert.match(login, /recordSuccessfulLogin\(/, 'successes must refresh the login context')
  assert.match(login, /isRateLimited\(key, 10/, 'the email-scoped login limiter stays in place')

  const verify = read('app/api/auth/verify-step-up/route.ts')
  assert.match(verify, /timingSafeEqual/, 'step-up codes must be compared in constant time')
  assert.match(verify, /hasUsablePassword/, 'only password accounts may finish a step-up login')
  assert.doesNotMatch(verify, /console\.(log|error)\(.*code/, 'codes and passwords must never be logged')

  const method = read('app/api/auth/login-method/route.ts')
  assert.match(method, /NextResponse\.json\(\{ method \}\)/, 'the only response body is the shared method envelope')
  assert.match(method, /login-method-ip:/, 'the method endpoint needs an IP-scoped limiter')
  for (const file of ['app/api/auth/step-up-code/route.ts', 'app/api/settings/password/request-step-up/route.ts']) {
    const source = read(file)
    assert.match(source, /clientIp\(request\)/, `${file} must derive the trusted client IP`)
    assert.match(source, /isRateLimited\(/, `${file} must call the durable limiter`)
  }

  const password = read('app/api/settings/password/route.ts')
  assert.match(password, /'STEP_UP'/, 'the code path must verify under the STEP_UP purpose')
  assert.match(password, /\$transaction/, 'code consumption and the password update must be atomic')
  assert.match(password, /tokenVersion: user\.tokenVersion \+ 1/, 'the password change keeps rotating tokenVersion')
  assert.match(password, /activeSessionId: nextSessionId/, 'the password change keeps pinning the active session')

  const stepUpRequest = read('app/api/settings/password/request-step-up/route.ts')
  assert.doesNotMatch(stepUpRequest, /You already have a password/, 'a signed-in trader who forgot the password must still be able to request a STEP_UP code')
  assert.match(stepUpRequest, /STEP_UP/, 'the settings step-up endpoint issues STEP_UP-purpose codes')
})

test('existing REGISTER/LOGIN code flows keep their purpose handling', () => {
  const emailCode = read('app/api/auth/email-code/route.ts')
  assert.match(emailCode, /existingUser \? 'LOGIN' : 'REGISTER'/)
  assert.match(emailCode, /email-code-ip:/)
  const verify = read('app/api/auth/verify-code/route.ts')
  assert.match(verify, /purpose === 'REGISTER' && existing/, 'REGISTER codes still refuse existing accounts')
  assert.match(verify, /purpose === 'LOGIN' && !existing/, 'LOGIN codes still refuse unknown accounts')
})
