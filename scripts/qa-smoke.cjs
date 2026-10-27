/* Local staging smoke QA for the PFT stress-test release. */
const { PrismaClient } = require('@prisma/client')
const { createHmac, randomBytes, scryptSync } = require('node:crypto')

const BASE = process.env.QA_BASE || 'http://127.0.0.1:3100'
const suffix = Date.now().toString(36)
const ADMIN_A = `qa-admin-a-${suffix}@pft.local`
const ADMIN_B = `qa-admin-b-${suffix}@pft.local`
const TRADER = `qa-trader-${suffix}@pft.local`
const RESET_TRADER = `qa-reset-${suffix}@pft.local`
const SHARE_TRADER = `qa-share-${suffix}@pft.local`
const RUN_START = new Date()
const IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET || 'qa-ipn-secret'
const PASSWORD = 'Qa-Password-123!'
const DAY_MS = 24 * 60 * 60 * 1000
const prisma = new PrismaClient()

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep(value[key])]),
    )
  }
  return value
}

function signIpn(body) {
  return createHmac('sha512', IPN_SECRET).update(JSON.stringify(sortKeysDeep(body))).digest('hex')
}

function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function request(path, init = {}, cookie) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) }
  if (cookie) headers.cookie = cookie
  const response = await fetch(`${BASE}${path}`, { ...init, headers })
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  const setCookies = response.headers.getSetCookie?.() || []
  const sessionCookie = setCookies
    .map((value) => value.split(';')[0])
    .find((value) => value.startsWith('pft_'))
  return { status: response.status, json, cookie: sessionCookie }
}

async function loginAdmin(email) {
  const response = await request('/api/admin/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  return response
}

async function cleanup() {
  const users = await prisma.user.findMany({
    where: { email: { in: [ADMIN_A, ADMIN_B, TRADER, RESET_TRADER, SHARE_TRADER] } },
    select: { id: true },
  })
  const userIds = users.map((user) => user.id)
  if (userIds.length === 0) return
  const accounts = await prisma.tradingAccount.findMany({
    where: { userId: { in: userIds } },
    select: { id: true },
  })
  const accountIds = accounts.map((account) => account.id)
  await prisma.auditLog.deleteMany({
    where: { OR: [{ actorId: { in: userIds } }, { accountId: { in: accountIds } }] },
  })
  await prisma.auditLog.deleteMany({
    where: { action: 'SESSION_RISK_SIGNAL', createdAt: { gte: RUN_START } },
  })
  await prisma.auditLog.deleteMany({
    where: { action: 'RULES_NOTICE_SENT', createdAt: { gte: RUN_START } },
  })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
}

async function main() {
  await cleanup()

  const home = await request('/')
  check('Public homepage loads', home.status === 200, `HTTP ${home.status}`)
  const loginPage = await request('/login')
  check('Trader login page loads', loginPage.status === 200, `HTTP ${loginPage.status}`)
  const adminLoginPage = await request('/admin/login')
  check('Admin login page loads', adminLoginPage.status === 200, `HTTP ${adminLoginPage.status}`)

  await prisma.user.createMany({
    data: [
      { email: ADMIN_A, name: 'QA Admin A', passwordHash: hashPassword(PASSWORD), role: 'ADMIN', kycStatus: 'APPROVED' },
      { email: ADMIN_B, name: 'QA Admin B', passwordHash: hashPassword(PASSWORD), role: 'ADMIN', kycStatus: 'APPROVED' },
      { email: TRADER, name: 'QA Trader', passwordHash: hashPassword(PASSWORD), role: 'TRADER', kycStatus: 'APPROVED' },
    ],
  })
  const trader = await prisma.user.findUniqueOrThrow({ where: { email: TRADER } })
  const account = await prisma.tradingAccount.create({
    data: {
      displayId: `QA-${suffix}`,
      userId: trader.id,
      mt5Login: `QA${suffix}`,
      mt5Server: 'QA-Server',
      planSize: 100000,
      challengeType: 'TWO_STEP',
      phase: 'FUNDED',
      status: 'PASSED_PHASE_2',
      initialBalance: 100000,
      dailyStartingBalance: 100000,
      dailyStartingEquity: 100000,
      dailyStartedAt: new Date(),
      currentBalance: 100000,
      currentEquity: 100000,
      dailyDrawdownPct: 0,
      maxDrawdownPct: 0,
      dailyDrawdownLimitPct: 5,
      maxDrawdownLimitPct: 10,
      profitPct: 0,
      balance: 100000,
      equity: 100000,
      startingBalance: 100000,
      peakEquity: 100000,
    },
  })

  const adminA = await loginAdmin(ADMIN_A)
  check('Admin A login', adminA.status === 200 && Boolean(adminA.cookie), `HTTP ${adminA.status}`)
  const adminB = await loginAdmin(ADMIN_B)
  check('Admin B login', adminB.status === 200 && Boolean(adminB.cookie), `HTTP ${adminB.status}`)

  const emptyQueue = await request('/api/admin/funding-approvals', {}, adminA.cookie)
  check('Funding queue endpoint', emptyQueue.status === 200 && Array.isArray(emptyQueue.json?.items), `HTTP ${emptyQueue.status}`)

  const login1 = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: TRADER, password: PASSWORD }),
  })
  check('Trader login #1', login1.status === 200 && Boolean(login1.cookie), `HTTP ${login1.status}`)

  const login2 = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: TRADER, password: PASSWORD }),
  })
  check('Trader login #2', login2.status === 200 && Boolean(login2.cookie), `HTTP ${login2.status}`)

  const staleSession = await request('/api/auth/me', {}, login1.cookie)
  check('Old concurrent session rejected', staleSession.status === 401, `HTTP ${staleSession.status}`)
  const freshSession = await request('/api/auth/me', {}, login2.cookie)
  check('New session accepted', freshSession.status === 200, `HTTP ${freshSession.status}`)

  const logout = await request('/api/auth/logout', { method: 'POST' }, login2.cookie)
  check('Logout succeeds', logout.status === 200, `HTTP ${logout.status}`)
  const afterLogout = await request('/api/auth/me', {}, login2.cookie)
  check('Session rejected after logout', afterLogout.status === 401, `HTTP ${afterLogout.status}`)
  const sessionState = await prisma.user.findUniqueOrThrow({ where: { id: trader.id }, select: { activeSessionId: true } })
  check('Logout clears activeSessionId', sessionState.activeSessionId === null, String(sessionState.activeSessionId))

  const requestFunding = await request(`/api/admin/accounts/${account.id}/override`, {
    method: 'POST',
    body: JSON.stringify({ status: 'FUNDED', reason: 'QA two-admin funding check' }),
  }, adminA.cookie)
  check(
    'FUNDED override creates approval request',
    requestFunding.status === 202 && requestFunding.json?.approvalRequired === true && Boolean(requestFunding.json?.requestId),
    `HTTP ${requestFunding.status}`,
  )
  const beforeApproval = await prisma.tradingAccount.findUniqueOrThrow({ where: { id: account.id } })
  check('Account not funded before second approval', beforeApproval.status === 'PASSED_PHASE_2', beforeApproval.status)

  const selfApproval = await request(`/api/admin/accounts/${account.id}/fund-approval`, {
    method: 'POST',
    body: JSON.stringify({ requestId: requestFunding.json.requestId, reason: 'QA self approval attempt' }),
  }, adminA.cookie)
  check('Requester cannot self-approve', selfApproval.status === 403, `HTTP ${selfApproval.status}`)

  const pending = await request('/api/admin/funding-approvals', {}, adminB.cookie)
  const pendingItem = pending.json?.items?.find((item) => item.requestId === requestFunding.json.requestId)
  check('Second admin sees pending request', Boolean(pendingItem), pendingItem ? pendingItem.displayId : 'missing')
  check('Pending request is not self-requested for admin B', pendingItem?.selfRequested === false)

  const approval = await request(`/api/admin/accounts/${account.id}/fund-approval`, {
    method: 'POST',
    body: JSON.stringify({ requestId: requestFunding.json.requestId, reason: 'QA second-admin approval' }),
  }, adminB.cookie)
  check('Second admin approves funding', approval.status === 200 && approval.json?.approved === true, `HTTP ${approval.status}`)
  const funded = await prisma.tradingAccount.findUniqueOrThrow({ where: { id: account.id } })
  check('Account is FUNDED after approval', funded.status === 'FUNDED' && funded.phase === 'FUNDED', `${funded.status}/${funded.phase}`)
  check('Funding resets balance to initial', Number(funded.currentBalance) === 100000, String(funded.currentBalance))

  const queueAfter = await request('/api/admin/funding-approvals', {}, adminB.cookie)
  check(
    'Approved request leaves the queue',
    !queueAfter.json?.items?.some((item) => item.requestId === requestFunding.json.requestId),
  )

  const login3 = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: TRADER, password: PASSWORD }),
  })
  const payout = await request('/api/payouts', {
    method: 'POST',
    body: JSON.stringify({
      accountId: account.id,
      amount: 1000,
      network: 'USDT_TRC20',
      walletAddress: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE',
    }),
  }, login3.cookie)
  check(
    'Payout gate rejects account without trades',
    payout.status >= 400 && payout.status < 500 && payout.json?.code === 'NO_TRADES',
    `HTTP ${payout.status} ${payout.json?.code || payout.json?.error || ''}`,
  )

  const noReason = await request(`/api/admin/accounts/${account.id}/override`, {
    method: 'POST',
    body: JSON.stringify({ status: 'PASSED_PHASE_1' }),
  }, adminA.cookie)
  check('Override without a reason is rejected', noReason.status === 400, `HTTP ${noReason.status}`)

  const requestPhase = await request(`/api/admin/accounts/${account.id}/override`, {
    method: 'POST',
    body: JSON.stringify({ status: 'PASSED_PHASE_1', reason: 'QA non-funding override check' }),
  }, adminA.cookie)
  check(
    'Non-FUNDED override creates approval request',
    requestPhase.status === 202 && requestPhase.json?.approvalRequired === true && Boolean(requestPhase.json?.requestId),
    `HTTP ${requestPhase.status}`,
  )
  const afterPhaseRequest = await prisma.tradingAccount.findUniqueOrThrow({ where: { id: account.id } })
  check('Status unchanged before second approval', afterPhaseRequest.status === 'FUNDED', afterPhaseRequest.status)

  const conflicting = await request(`/api/admin/accounts/${account.id}/override`, {
    method: 'POST',
    body: JSON.stringify({ status: 'BREACHED_DAILY', reason: 'QA conflicting override' }),
  }, adminA.cookie)
  check('Second pending target status is blocked', conflicting.status === 409, `HTTP ${conflicting.status}`)

  const phaseQueue = await request('/api/admin/funding-approvals', {}, adminB.cookie)
  const phaseItem = phaseQueue.json?.items?.find((item) => item.requestId === requestPhase.json.requestId)
  check('Override queue exposes target status', phaseItem?.status === 'PASSED_PHASE_1', String(phaseItem?.status))

  const selfApprovePhase = await request(`/api/admin/accounts/${account.id}/override-approval`, {
    method: 'POST',
    body: JSON.stringify({ requestId: requestPhase.json.requestId, reason: 'QA self approval attempt' }),
  }, adminA.cookie)
  check('Requester cannot self-approve non-FUNDED override', selfApprovePhase.status === 403, `HTTP ${selfApprovePhase.status}`)

  const approvePhase = await request(`/api/admin/accounts/${account.id}/override-approval`, {
    method: 'POST',
    body: JSON.stringify({ requestId: requestPhase.json.requestId, reason: 'QA second-admin non-funding approval' }),
  }, adminB.cookie)
  check(
    'Second admin approves non-FUNDED override',
    approvePhase.status === 200 && approvePhase.json?.approved === true,
    `HTTP ${approvePhase.status}`,
  )
  const afterPhaseApproval = await prisma.tradingAccount.findUniqueOrThrow({ where: { id: account.id } })
  check('Account status updated after approval', afterPhaseApproval.status === 'PASSED_PHASE_1', afterPhaseApproval.status)

  const breachAccount = await prisma.tradingAccount.create({
    data: {
      displayId: `QA-BREACH-${suffix}`,
      userId: trader.id,
      mt5Login: `QAB${suffix}`,
      mt5Server: 'QA-Server',
      planSize: 100000,
      challengeType: 'TWO_STEP',
      phase: 'PHASE_1',
      status: 'ACTIVE',
      initialBalance: 100000,
      dailyStartingBalance: 100000,
      dailyStartingEquity: 100000,
      dailyStartedAt: new Date(),
      currentBalance: 100000,
      currentEquity: 100000,
      dailyDrawdownPct: 0,
      maxDrawdownPct: 0,
      dailyDrawdownLimitPct: 5,
      maxDrawdownLimitPct: 10,
      profitPct: 0,
      balance: 100000,
      equity: 100000,
      startingBalance: 100000,
      peakEquity: 100000,
    },
  })

  const breach = await request(`/api/admin/accounts/${breachAccount.id}/breach`, {
    method: 'POST',
    body: JSON.stringify({ type: 'BREACHED_DAILY', reason: 'QA breach for post-action review' }),
  }, adminA.cookie)
  check('Breach kill-switch executes immediately', breach.status === 200 && breach.json?.account?.status === 'BREACHED_DAILY', `HTTP ${breach.status}`)

  const breachReviews = await request('/api/admin/action-reviews', {}, adminB.cookie)
  const breachReview = breachReviews.json?.items?.find((item) => item.accountId === breachAccount.id)
  check('Breach creates a post-action review', breachReview?.kind === 'BREACH', String(breachReview?.kind))
  check('Breach review is not self-performed for admin B', breachReview?.selfPerformed === false)

  const selfReview = await request(`/api/admin/accounts/${breachAccount.id}/action-review`, {
    method: 'POST',
    body: JSON.stringify({ requestId: breachReview?.requestId, decision: 'confirm', note: 'QA self review attempt' }),
  }, adminA.cookie)
  check('Actor cannot review their own breach', selfReview.status === 403, `HTTP ${selfReview.status}`)

  const emptyNote = await request(`/api/admin/accounts/${breachAccount.id}/action-review`, {
    method: 'POST',
    body: JSON.stringify({ requestId: breachReview?.requestId, decision: 'confirm', note: '   ' }),
  }, adminB.cookie)
  check('Review note is required', emptyNote.status === 400, `HTTP ${emptyNote.status}`)

  const confirmBreach = await request(`/api/admin/accounts/${breachAccount.id}/action-review`, {
    method: 'POST',
    body: JSON.stringify({ requestId: breachReview?.requestId, decision: 'confirm', note: 'QA second-admin breach review' }),
  }, adminB.cookie)
  check('Second admin confirms breach review', confirmBreach.status === 200 && confirmBreach.json?.reviewed === true, `HTTP ${confirmBreach.status}`)

  const reviewsAfterBreach = await request('/api/admin/action-reviews', {}, adminB.cookie)
  check(
    'Reviewed breach leaves the queue',
    !reviewsAfterBreach.json?.items?.some((item) => item.requestId === breachReview?.requestId),
  )

  const reset = await request(`/api/admin/accounts/${breachAccount.id}/reset`, {
    method: 'POST',
    body: JSON.stringify({ confirm: true }),
  }, adminA.cookie)
  check('Admin reset provisions a fresh account', reset.status === 200 && Boolean(reset.json?.account?.id), `HTTP ${reset.status}`)

  const resetReviews = await request('/api/admin/action-reviews', {}, adminB.cookie)
  const resetReview = reset.json?.account?.id
    ? resetReviews.json?.items?.find((item) => item.accountId === reset.json.account.id)
    : null
  check('Reset creates a post-action review', resetReview?.kind === 'RESET', String(resetReview?.kind))

  const flagReset = await request(`/api/admin/accounts/${reset.json?.account?.id}/action-review`, {
    method: 'POST',
    body: JSON.stringify({ requestId: resetReview?.requestId, decision: 'flag', note: 'QA flagged reset for follow-up' }),
  }, adminB.cookie)
  check('Second admin flags reset review', flagReset.status === 200 && flagReset.json?.decision === 'flag', `HTTP ${flagReset.status}`)

  const reviewsAfterReset = await request('/api/admin/action-reviews', {}, adminB.cookie)
  check(
    'Flagged reset leaves the queue',
    !reviewsAfterReset.json?.items?.some((item) => item.requestId === resetReview?.requestId),
  )

  // Breach appeals: filed by the trader, decided by an admin who did not close the account.
  const appealAccount = await prisma.tradingAccount.create({
    data: {
      displayId: `QA-APPEAL-${suffix}`,
      userId: trader.id,
      mt5Login: `QAA${suffix}`,
      mt5Server: 'QA-Server',
      planSize: 100000,
      challengeType: 'TWO_STEP',
      phase: 'PHASE_1',
      status: 'ACTIVE',
      initialBalance: 100000,
      dailyStartingBalance: 100000,
      dailyStartingEquity: 100000,
      dailyStartedAt: new Date(),
      currentBalance: 100000,
      currentEquity: 100000,
      dailyDrawdownPct: 0,
      maxDrawdownPct: 0,
      dailyDrawdownLimitPct: 5,
      maxDrawdownLimitPct: 10,
      profitPct: 0,
      balance: 100000,
      equity: 100000,
      startingBalance: 100000,
      peakEquity: 100000,
    },
  })

  const appealBreach = await request(`/api/admin/accounts/${appealAccount.id}/breach`, {
    method: 'POST',
    body: JSON.stringify({ type: 'BREACHED_DAILY', reason: 'QA breach for appeal flow' }),
  }, adminA.cookie)
  check('Appeal fixture account breached', appealBreach.status === 200, `HTTP ${appealBreach.status}`)

  const shortAppeal = await request('/api/trading/appeal', {
    method: 'POST',
    body: JSON.stringify({ accountId: appealAccount.id, reason: 'too short' }),
  }, login3.cookie)
  check('Appeal reason must be descriptive', shortAppeal.status === 400, `HTTP ${shortAppeal.status}`)

  const filed = await request('/api/trading/appeal', {
    method: 'POST',
    body: JSON.stringify({
      accountId: appealAccount.id,
      reason: 'QA appeal: the drawdown figure was calculated from a stale equity snapshot.',
    }),
  }, login3.cookie)
  check('Trader files a breach appeal', filed.status === 201 && Boolean(filed.json?.appeal?.id), `HTTP ${filed.status}`)

  const duplicateAppeal = await request('/api/trading/appeal', {
    method: 'POST',
    body: JSON.stringify({
      accountId: appealAccount.id,
      reason: 'QA duplicate appeal for the same breach decision.',
    }),
  }, login3.cookie)
  check('Duplicate open appeal is rejected', duplicateAppeal.status === 409, `HTTP ${duplicateAppeal.status}`)

  const adminAppeals = await request('/api/admin/appeals', {}, adminB.cookie)
  const queueItem = adminAppeals.json?.items?.find((item) => item.accountId === appealAccount.id)
  check('Admin appeal queue lists the appeal', Boolean(queueItem), queueItem?.id)

  const selfAppealReview = await request(`/api/admin/accounts/${appealAccount.id}/appeal`, {
    method: 'POST',
    body: JSON.stringify({ appealId: queueItem?.id, decision: 'overturn', note: 'QA self review attempt' }),
  }, adminA.cookie)
  check('Admin who closed the account cannot decide its appeal', selfAppealReview.status === 403, `HTTP ${selfAppealReview.status}`)

  const overturn = await request(`/api/admin/accounts/${appealAccount.id}/appeal`, {
    method: 'POST',
    body: JSON.stringify({
      appealId: queueItem?.id,
      decision: 'overturn',
      note: 'QA second admin overturns after reviewing the equity snapshot.',
    }),
  }, adminB.cookie)
  check('Second admin overturns the appeal', overturn.status === 200 && overturn.json?.appeal?.status === 'OVERTURNED', `HTTP ${overturn.status}`)

  const restored = await prisma.tradingAccount.findUniqueOrThrow({ where: { id: appealAccount.id } })
  check('Overturned appeal restores the account', restored.status === 'ACTIVE' && restored.breachReason === null, restored.status)

  const appealsAfterDecision = await request('/api/admin/appeals', {}, adminB.cookie)
  check(
    'Decided appeal leaves the queue',
    !appealsAfterDecision.json?.items?.some((item) => item.id === queueItem?.id),
  )

  // Paid reset: eligibility, webhook provisioning and the 30-day cap.
  // Detach the reset trader from the other QA accounts so the account-count limit
  // (same IP + device fingerprint) cannot mask the reset rules under test.
  await prisma.user.update({
    where: { id: trader.id },
    data: { lastLoginIp: null, lastDeviceHash: null },
  })
  await prisma.user.create({
    data: {
      email: RESET_TRADER,
      name: 'QA Reset Trader',
      passwordHash: hashPassword(PASSWORD),
      role: 'TRADER',
      kycStatus: 'APPROVED',
    },
  })
  const resetTrader = await prisma.user.findUniqueOrThrow({ where: { email: RESET_TRADER } })
  const resetLogin = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: RESET_TRADER, password: PASSWORD }),
  })
  check('Reset trader login', resetLogin.status === 200 && Boolean(resetLogin.cookie), `HTTP ${resetLogin.status}`)

  const resetSource = await prisma.tradingAccount.create({
    data: {
      displayId: `QA-RESET-${suffix}`,
      userId: resetTrader.id,
      mt5Login: `QAR${suffix}`,
      mt5Server: 'QA-Server',
      planSize: 100000,
      challengeType: 'TWO_STEP',
      phase: 'PHASE_1',
      status: 'BREACHED_MAX',
      breachReason: 'Max trailing drawdown breached: equity 89000 fell below floor 90000',
      frozenAt: new Date(),
      drawdownMode: 'trailing',
      initialBalance: 100000,
      dailyStartingBalance: 100000,
      dailyStartingEquity: 100000,
      dailyStartedAt: new Date(),
      currentBalance: 89000,
      currentEquity: 89000,
      dailyDrawdownPct: 0,
      maxDrawdownPct: 11,
      dailyDrawdownLimitPct: 5,
      maxDrawdownLimitPct: 10,
      profitPct: 0,
      balance: 89000,
      equity: 89000,
      startingBalance: 100000,
      peakEquity: 100000,
    },
  })

  const resetEligibility = await request(`/api/accounts/${resetSource.id}/reset`, {}, resetLogin.cookie)
  check(
    'Breached account is reset-eligible',
    resetEligibility.status === 200 && resetEligibility.json?.eligible === true,
    `HTTP ${resetEligibility.status}`,
  )
  check(
    'Reset applies the 20% breach-week discount',
    resetEligibility.json?.discountPct === 20 && resetEligibility.json?.price > 0,
    `${resetEligibility.json?.discountPct}% · $${resetEligibility.json?.price}`,
  )

  const resetPrice = Number(resetEligibility.json?.price ?? 0)
  const resetPayload = {
    product: 'RESET',
    resetAccountId: resetSource.id,
    planSize: 100000,
    evaluationType: '2-Step',
    drawdownMode: 'trailing',
    dailyLossType: 5,
    discountPct: 20,
    basePrice: Math.round((resetPrice / 0.8) * 100) / 100,
    totalAmount: resetPrice,
  }
  const resetOrderId = `QA-RESET-${suffix}`
  await prisma.order.create({
    data: {
      userId: resetTrader.id,
      provider: 'nowpayments',
      providerOrderId: resetOrderId,
      amount: resetPrice.toString(),
      currency: 'USD',
      status: 'PENDING',
      rawPayload: resetPayload,
    },
  })

  const resetIpn = {
    order_id: resetOrderId,
    payment_status: 'finished',
    price_amount: resetPrice,
    price_currency: 'usd',
    payment_id: `qa-reset-${suffix}`,
  }
  const resetWebhook = await request('/api/webhooks/payment-success', {
    method: 'POST',
    headers: { 'x-nowpayments-sig': signIpn(resetIpn) },
    body: JSON.stringify(resetIpn),
  })
  check(
    'Paid reset webhook provisions a fresh account',
    resetWebhook.status === 200 && !resetWebhook.json?.provisioningBlocked,
    `HTTP ${resetWebhook.status} ${resetWebhook.json?.reason ?? ''}`,
  )

  const freshReset = await prisma.tradingAccount.findFirst({
    where: { resetSourceAccountId: resetSource.id },
    select: { id: true, status: true, phase: true },
  })
  check(
    'Reset account starts a fresh Phase 1',
    freshReset?.status === 'ACTIVE' && freshReset?.phase === 'PHASE_1',
    `${freshReset?.status}/${freshReset?.phase}`,
  )

  const resetOrder = await prisma.order.findUniqueOrThrow({ where: { providerOrderId: resetOrderId } })
  check('Reset order is marked provisioned', resetOrder.status === 'PAID' && Boolean(resetOrder.provisionedAt))

  const secondOrderId = `QA-RESET2-${suffix}`
  await prisma.order.create({
    data: {
      userId: resetTrader.id,
      provider: 'nowpayments',
      providerOrderId: secondOrderId,
      amount: resetPrice.toString(),
      currency: 'USD',
      status: 'PENDING',
      rawPayload: resetPayload,
    },
  })
  const secondIpn = { ...resetIpn, order_id: secondOrderId, payment_id: `qa-reset2-${suffix}` }
  const secondWebhook = await request('/api/webhooks/payment-success', {
    method: 'POST',
    headers: { 'x-nowpayments-sig': signIpn(secondIpn) },
    body: JSON.stringify(secondIpn),
  })
  check(
    'Second paid reset within 30 days is blocked',
    secondWebhook.status === 200 && secondWebhook.json?.provisioningBlocked === true,
    secondWebhook.json?.reason ?? `HTTP ${secondWebhook.status}`,
  )

  // Frozen backup add-on: the provisioned backup links to its primary (rulebook 18.3).
  const purchaseOrderId = `QA-BACKUP-${suffix}`
  await prisma.order.create({
    data: {
      userId: resetTrader.id,
      provider: 'nowpayments',
      providerOrderId: purchaseOrderId,
      amount: '200.00',
      currency: 'USD',
      status: 'PENDING',
      rawPayload: {
        planSize: 25000,
        evaluationType: '2-Step',
        drawdownMode: 'trailing',
        dailyLossType: 5,
        hasFrozenBackup: true,
      },
    },
  })
  const purchaseIpn = {
    order_id: purchaseOrderId,
    payment_status: 'finished',
    price_amount: 200,
    price_currency: 'usd',
    payment_id: `qa-backup-${suffix}`,
  }
  const purchaseWebhook = await request('/api/webhooks/payment-success', {
    method: 'POST',
    headers: { 'x-nowpayments-sig': signIpn(purchaseIpn) },
    body: JSON.stringify(purchaseIpn),
  })
  check(
    'Purchase with frozen backup provisions both accounts',
    purchaseWebhook.status === 200 && !purchaseWebhook.json?.provisioningBlocked,
    `HTTP ${purchaseWebhook.status} ${purchaseWebhook.json?.reason ?? ''}`,
  )

  const purchasePrimary = await prisma.tradingAccount.findFirst({
    where: { userId: resetTrader.id, planSize: 25000, isFrozenBackup: false },
    select: { id: true },
  })
  const purchaseBackup = await prisma.tradingAccount.findFirst({
    where: { userId: resetTrader.id, isFrozenBackup: true, backupForAccountId: purchasePrimary?.id ?? '' },
    select: { id: true, status: true },
  })
  check(
    'Frozen backup is linked to its primary account',
    Boolean(purchaseBackup?.id) && purchaseBackup?.status === 'FROZEN_STANDBY',
    purchaseBackup?.status,
  )

  // Automated enforcement: the cron applies the breach matrix to engine-closed accounts.
  const cronAccount = await prisma.tradingAccount.create({
    data: {
      displayId: `QA-CRON-${suffix}`,
      userId: trader.id,
      mt5Login: `QAC${suffix}`,
      mt5Server: 'QA-Server',
      planSize: 100000,
      challengeType: 'TWO_STEP',
      phase: 'FUNDED',
      status: 'BREACHED_MAX',
      breachReason: 'Max trailing drawdown breached: equity 89000 fell below floor 90000',
      frozenAt: new Date(),
      initialBalance: 100000,
      dailyStartingBalance: 100000,
      dailyStartingEquity: 100000,
      dailyStartedAt: new Date(),
      currentBalance: 89000,
      currentEquity: 89000,
      dailyDrawdownPct: 0,
      maxDrawdownPct: 11,
      dailyDrawdownLimitPct: 5,
      maxDrawdownLimitPct: 10,
      profitPct: 0,
      balance: 89000,
      equity: 89000,
      startingBalance: 100000,
      peakEquity: 100000,
    },
  })
  const cronPayout = await prisma.payout.create({
    data: {
      userId: trader.id,
      accountId: cronAccount.id,
      amount: 500,
      walletAddress: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE',
      network: 'USDT_TRC20',
      status: 'PENDING',
    },
  })

  // Frozen backup expiry: a backup expires without refund when its primary passes (18.3).
  const passPrimary = await prisma.tradingAccount.create({
    data: {
      displayId: `QA-PASS-${suffix}`,
      userId: trader.id,
      mt5Login: `QAP${suffix}`,
      mt5Server: 'QA-Server',
      planSize: 100000,
      challengeType: 'ONE_STEP',
      phase: 'PHASE_1',
      status: 'ACTIVE',
      profitTarget: 0.01,
      createdAt: new Date(Date.now() - 5 * DAY_MS),
      initialBalance: 100000,
      dailyStartingBalance: 100000,
      dailyStartingEquity: 100000,
      dailyStartedAt: new Date(),
      currentBalance: 101500,
      currentEquity: 101500,
      dailyDrawdownPct: 0,
      maxDrawdownPct: 0,
      dailyDrawdownLimitPct: 4,
      maxDrawdownLimitPct: 6,
      profitPct: 1.5,
      balance: 101500,
      equity: 101500,
      startingBalance: 100000,
      peakEquity: 101500,
    },
  })
  const passBackup = await prisma.tradingAccount.create({
    data: {
      displayId: `QA-PASS-BU-${suffix}`,
      userId: trader.id,
      mt5Login: `QAPB${suffix}`,
      mt5Server: 'QA-Server',
      planSize: 100000,
      challengeType: 'ONE_STEP',
      phase: 'PHASE_1',
      status: 'FROZEN_STANDBY',
      isFrozenBackup: true,
      backupForAccountId: passPrimary.id,
      frozenAt: new Date(),
      initialBalance: 100000,
      dailyStartingBalance: 100000,
      dailyStartingEquity: 100000,
      dailyStartedAt: new Date(),
      currentBalance: 100000,
      currentEquity: 100000,
      dailyDrawdownPct: 0,
      maxDrawdownPct: 0,
      dailyDrawdownLimitPct: 4,
      maxDrawdownLimitPct: 6,
      profitPct: 0,
      balance: 100000,
      equity: 100000,
      startingBalance: 100000,
      peakEquity: 100000,
    },
  })
  for (const offset of [4, 3, 2]) {
    await prisma.tradeHistory.create({
      data: {
        tradingAccountId: passPrimary.id,
        symbol: 'EURUSD',
        side: 'BUY',
        sizeLots: 0.1,
        entryPrice: 1.1,
        exitPrice: 1.101,
        pnl: 500,
        closeReason: 'MANUAL',
        openedAt: new Date(Date.now() - offset * DAY_MS),
        closedAt: new Date(Date.now() - offset * DAY_MS + 60 * 60_000),
      },
    })
  }

  // User-level risk flag: news violations across two accounts (rulebook 9.4).
  const riskAccounts = []
  for (const index of [1, 2]) {
    const riskAccount = await prisma.tradingAccount.create({
      data: {
        displayId: `QA-RISK-${index}-${suffix}`,
        userId: trader.id,
        mt5Login: `QARX${index}${suffix}`,
        mt5Server: 'QA-Server',
        planSize: 5000,
        challengeType: 'TWO_STEP',
        phase: 'PHASE_1',
        status: 'ACTIVE',
        initialBalance: 5000,
        dailyStartingBalance: 5000,
        dailyStartingEquity: 5000,
        dailyStartedAt: new Date(),
        currentBalance: 5000,
        currentEquity: 5000,
        dailyDrawdownPct: 0,
        maxDrawdownPct: 0,
        dailyDrawdownLimitPct: 5,
        maxDrawdownLimitPct: 10,
        profitPct: 0,
        balance: 5000,
        equity: 5000,
        startingBalance: 5000,
        peakEquity: 5000,
      },
    })
    riskAccounts.push(riskAccount)
    await prisma.auditLog.create({
      data: {
        accountId: riskAccount.id,
        action: 'NEWS_WINDOW_EXPOSURE',
        reason: 'News window exposure: QA Non-Farm Payrolls',
        metadata: {
          eventId: 'qa-nfp',
          eventTitle: 'QA Non-Farm Payrolls',
          eventTime: new Date().toISOString(),
          positionId: `qa-risk-pos-${index}`,
          symbol: 'EURUSD',
          annulledPnl: 0,
          violationNumber: 1,
        },
      },
    })
  }

  // Funded account used only to observe the user-level payout gate.
  const riskPayoutAccount = await prisma.tradingAccount.create({
    data: {
      displayId: `QA-RISK-PAY-${suffix}`,
      userId: trader.id,
      mt5Login: `QARY${suffix}`,
      mt5Server: 'QA-Server',
      planSize: 5000,
      challengeType: 'TWO_STEP',
      phase: 'FUNDED',
      status: 'FUNDED',
      initialBalance: 5000,
      dailyStartingBalance: 5000,
      dailyStartingEquity: 5000,
      dailyStartedAt: new Date(),
      currentBalance: 5000,
      currentEquity: 5000,
      dailyDrawdownPct: 0,
      maxDrawdownPct: 0,
      dailyDrawdownLimitPct: 5,
      maxDrawdownLimitPct: 10,
      profitPct: 0,
      balance: 5000,
      equity: 5000,
      startingBalance: 5000,
      peakEquity: 5000,
    },
  })

  // Rulebook versioning: the cron announces a newer rules version once per trader.
  await prisma.user.update({
    where: { id: trader.id },
    data: { rulesNotifiedVersion: '1.5' },
  })

  const cronHeaders = { authorization: `Bearer ${process.env.CRON_SECRET ?? ''}` }
  const cron = await request('/api/cron/trading', { headers: cronHeaders })
  check('Trading cron runs', cron.status === 200, `HTTP ${cron.status}`)

  const appliedEntry = cron.json?.enforcement?.applied?.find((item) => item.accountId === cronAccount.id)
  check('Cron applies the breach matrix to a closed account', Boolean(appliedEntry), appliedEntry?.kind)

  const enforcedPayout = await prisma.payout.findUniqueOrThrow({ where: { id: cronPayout.id } })
  check('Automated breach cancels unpaid profit', enforcedPayout.status === 'REJECTED', enforcedPayout.status)

  const breachAudit = await prisma.auditLog.findFirst({
    where: { accountId: cronAccount.id, action: 'ACCOUNT_BREACH', actorId: null },
    select: { id: true, metadata: true },
  })
  check('Automated breach is audited as a system action', Boolean(breachAudit?.id))

  const reviewsWithAutomated = await request('/api/admin/action-reviews', {}, adminB.cookie)
  const automatedReview = reviewsWithAutomated.json?.items?.find((item) => item.accountId === cronAccount.id)
  check(
    'Automated breach requires a post-action review',
    Boolean(automatedReview?.automated),
    automatedReview?.performedBy,
  )

  const cronAgain = await request('/api/cron/trading', { headers: cronHeaders })
  check(
    'Automated enforcement is idempotent',
    !cronAgain.json?.enforcement?.applied?.some((item) => item.accountId === cronAccount.id),
  )

  const rulesUser = await prisma.user.findUniqueOrThrow({
    where: { id: trader.id },
    select: { rulesNotifiedVersion: true },
  })
  check(
    'Cron announces the current rules version',
    cron.json?.rules?.version === '1.6' && rulesUser.rulesNotifiedVersion === '1.6',
    `${cron.json?.rules?.version ?? 'n/a'} · notified ${rulesUser.rulesNotifiedVersion ?? 'n/a'}`,
  )

  const rulesAudits = await prisma.auditLog.findMany({
    where: { action: 'RULES_NOTICE_SENT', createdAt: { gte: RUN_START } },
    select: { metadata: true },
  })
  const rulesAuditUser = rulesAudits
    .map((audit) =>
      audit.metadata && typeof audit.metadata === 'object' && !Array.isArray(audit.metadata)
        ? audit.metadata.userId
        : null,
    )
    .find((userId) => userId === trader.id)
  check(
    'Rules notice is audited per trader',
    rulesAuditUser === trader.id,
    `${rulesAudits.length} notice(s): ${String(rulesAuditUser ?? 'trader missing')}`,
  )

  const backupAfterPass = await prisma.tradingAccount.findUniqueOrThrow({
    where: { id: passBackup.id },
    select: { status: true },
  })
  check('Backup expires when its primary passes', backupAfterPass.status === 'EXPIRED', backupAfterPass.status)

  const backupExpiryAudit = await prisma.auditLog.findFirst({
    where: { accountId: passBackup.id, action: 'BACKUP_EXPIRED' },
    select: { id: true },
  })
  check('Backup expiry is audited', Boolean(backupExpiryAudit?.id))

  const riskFlaggedUser = await prisma.user.findUniqueOrThrow({
    where: { id: trader.id },
    select: { riskFlaggedAt: true, riskFlagReason: true },
  })
  check(
    'Cron opens a user risk review after repeated news violations',
    Boolean(riskFlaggedUser.riskFlaggedAt) &&
      Boolean(cron.json?.riskFlags?.flagged?.some((item) => item.userId === trader.id)),
    riskFlaggedUser.riskFlagReason ?? 'not flagged',
  )

  const payoutBody = {
    accountId: riskPayoutAccount.id,
    amount: 1000,
    network: 'USDT_TRC20',
    walletAddress: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE',
  }
  const flaggedPayout = await request('/api/payouts', { method: 'POST', body: JSON.stringify(payoutBody) }, login3.cookie)
  check(
    'Risk review pauses payouts',
    flaggedPayout.status === 409 && flaggedPayout.json?.code === 'RISK_REVIEW_HOLD',
    `HTTP ${flaggedPayout.status} ${flaggedPayout.json?.code ?? ''}`,
  )

  const shortRiskReason = await request(`/api/admin/users/${trader.id}/risk-flag`, {
    method: 'POST',
    body: JSON.stringify({ action: 'clear', reason: 'short' }),
  }, adminB.cookie)
  check('Risk flag change requires a reason', shortRiskReason.status === 400, `HTTP ${shortRiskReason.status}`)

  const clearedRiskFlag = await request(`/api/admin/users/${trader.id}/risk-flag`, {
    method: 'POST',
    body: JSON.stringify({ action: 'clear', reason: 'QA reviewed the flagged news violations manually' }),
  }, adminB.cookie)
  check(
    'Admin clears the risk review',
    clearedRiskFlag.status === 200 && clearedRiskFlag.json?.flagged === false,
    `HTTP ${clearedRiskFlag.status}`,
  )

  const payoutAfterClear = await request('/api/payouts', { method: 'POST', body: JSON.stringify(payoutBody) }, login3.cookie)
  check(
    'Cleared risk review releases the payout gate',
    payoutAfterClear.status === 400 && payoutAfterClear.json?.code === 'NO_TRADES',
    `HTTP ${payoutAfterClear.status} ${payoutAfterClear.json?.code ?? ''}`,
  )

  // Session risk signals: country changes, declared VPS and shared-device detection.
  async function sessionSignals() {
    const logs = await prisma.auditLog.findMany({
      where: { action: 'SESSION_RISK_SIGNAL', createdAt: { gte: RUN_START } },
      select: { metadata: true },
    })
    return logs
      .map((log) =>
        log.metadata && typeof log.metadata === 'object' && !Array.isArray(log.metadata)
          ? log.metadata.signal
          : null,
      )
      .filter((signal) => typeof signal === 'string')
  }

  const loginCountry1 = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'x-country-code': 'DE', 'x-forwarded-for': '203.0.113.10' },
    body: JSON.stringify({ email: TRADER, password: PASSWORD }),
  })
  const firstAccessEvent = await prisma.accessEvent.findFirst({
    where: { userId: trader.id },
    orderBy: { createdAt: 'desc' },
    select: { country: true, deviceHash: true },
  })
  check(
    'Login fingerprint records the country',
    loginCountry1.status === 200 && firstAccessEvent?.country === 'DE',
    firstAccessEvent?.country ?? `HTTP ${loginCountry1.status}`,
  )

  const loginCountry2 = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'x-country-code': 'US', 'x-forwarded-for': '203.0.113.20' },
    body: JSON.stringify({ email: TRADER, password: PASSWORD }),
  })
  const countrySignals = await sessionSignals()
  check(
    'Concurrent country sign-in raises a session alert',
    loginCountry2.status === 200 &&
      countrySignals.includes('NEW_COUNTRY') &&
      countrySignals.includes('CONCURRENT_COUNTRY'),
    countrySignals.join(', '),
  )

  await prisma.user.update({
    where: { id: trader.id },
    data: { declaredVpsCountry: 'DE', vpsDeclaredAt: new Date() },
  })
  const loginVpsMismatch = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'x-country-code': 'FR', 'x-forwarded-for': '203.0.113.30' },
    body: JSON.stringify({ email: TRADER, password: PASSWORD }),
  })
  const vpsSignals = await sessionSignals()
  check(
    'Sign-in outside the declared VPS country raises an alert',
    loginVpsMismatch.status === 200 && vpsSignals.includes('VPS_LOCATION_MISMATCH'),
    vpsSignals.join(', '),
  )

  await prisma.user.create({
    data: {
      email: SHARE_TRADER,
      name: 'QA Share Trader',
      passwordHash: hashPassword(PASSWORD),
      role: 'TRADER',
      kycStatus: 'APPROVED',
      lastLoginIp: '203.0.113.30',
      lastDeviceHash: firstAccessEvent?.deviceHash ?? null,
    },
  })
  const loginShared = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'x-country-code': 'DE', 'x-forwarded-for': '203.0.113.30' },
    body: JSON.stringify({ email: TRADER, password: PASSWORD }),
  })
  const shareSignals = await sessionSignals()
  check(
    'Shared device and network raises a sharing alert',
    loginShared.status === 200 && shareSignals.includes('SHARED_ACCESS'),
    shareSignals.join(', '),
  )

  const tradersWithAlerts = await request(`/api/admin/traders?q=${encodeURIComponent(trader.email)}`, {}, adminA.cookie)
  check(
    'Admin desk surfaces session alerts',
    tradersWithAlerts.status === 200 &&
      tradersWithAlerts.json?.items?.some((item) => (item.sessionAlerts ?? 0) > 0),
    `HTTP ${tradersWithAlerts.status}`,
  )

  await cleanup()
  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error('QA failed:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
