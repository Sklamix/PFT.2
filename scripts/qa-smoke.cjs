/* Local staging smoke QA for the PFT stress-test release. */
const { PrismaClient } = require('@prisma/client')
const { randomBytes, scryptSync } = require('node:crypto')

const BASE = process.env.QA_BASE || 'http://127.0.0.1:3100'
const suffix = Date.now().toString(36)
const ADMIN_A = `qa-admin-a-${suffix}@pft.local`
const ADMIN_B = `qa-admin-b-${suffix}@pft.local`
const TRADER = `qa-trader-${suffix}@pft.local`
const PASSWORD = 'Qa-Password-123!'
const prisma = new PrismaClient()

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
    where: { email: { in: [ADMIN_A, ADMIN_B, TRADER] } },
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
