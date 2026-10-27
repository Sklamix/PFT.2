import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../lib/admin/auth'
import { recomputeMetrics } from '../lib/admin/risk'

const prisma = new PrismaClient()

async function main() {
  await prisma.trade.deleteMany()
  await prisma.payout.deleteMany()
  await prisma.order.deleteMany()
  await prisma.auditLog.deleteMany()
  await prisma.tradingAccount.deleteMany()
  await prisma.user.deleteMany()

  const password = hashPassword('trader-demo')

  const [admin, _risk, marcus, nina, erik, lana, theo] = await Promise.all([
    prisma.user.create({
      data: {
        email: 'ops@pft.local',
        passwordHash: hashPassword(process.env.ADMIN_BOOTSTRAP_PASSWORD || 'PFT-Admin-Desk!'),
        name: 'Operations Desk',
        role: 'ADMIN',
        kycStatus: 'APPROVED',
        telegram: '@pft_ops',
        discord: 'pft-ops#0001',
      },
    }),
    prisma.user.create({
      data: {
        email: 'risk@pft.local',
        passwordHash: hashPassword(process.env.RISK_BOOTSTRAP_PASSWORD || 'PFT-Risk-Desk!'),
        name: 'Risk Manager',
        role: 'RISK_MANAGER',
        kycStatus: 'APPROVED',
        telegram: '@pft_risk',
        discord: 'pft-risk#0001',
      },
    }),
    prisma.user.create({
      data: {
        email: 'marcus.vale@example.com',
        passwordHash: password,
        name: 'Marcus Vale',
        role: 'TRADER',
        kycStatus: 'APPROVED',
        telegram: '@marcusvale',
        discord: 'marcus#4421',
      },
    }),
    prisma.user.create({
      data: {
        email: 'nina.okoye@example.com',
        passwordHash: password,
        name: 'Nina Okoye',
        role: 'TRADER',
        kycStatus: 'APPROVED',
        telegram: '@ninaokoye',
        discord: 'nina#1102',
      },
    }),
    prisma.user.create({
      data: {
        email: 'erik.sund@example.com',
        passwordHash: password,
        name: 'Erik Sund',
        role: 'TRADER',
        kycStatus: 'PENDING',
        telegram: '@eriksund',
      },
    }),
    prisma.user.create({
      data: {
        email: 'lana.cho@example.com',
        passwordHash: password,
        name: 'Lana Cho',
        role: 'TRADER',
        kycStatus: 'APPROVED',
        discord: 'lana#9088',
      },
    }),
    prisma.user.create({
      data: {
        email: 'theo.raines@example.com',
        passwordHash: password,
        name: 'Theo Raines',
        role: 'TRADER',
        kycStatus: 'APPROVED',
        telegram: '@theoraines',
        discord: 'theo#2210',
      },
    }),
  ])

  const books = [
    {
      displayId: 'PFT-100K-98214',
      userId: marcus.id,
      mt5Login: '5100982140',
      mt5Server: 'PFT-Demo-Server',
      planSize: 100000,
      challengeType: 'TWO_STEP' as const,
      phase: 'PHASE_1' as const,
      status: 'ACTIVE' as const,
      leverage: '1:100',
      initialBalance: 100000,
      dailyStartingEquity: 108600,
      currentBalance: 108420,
      currentEquity: 108420,
      tradingDaysCount: 4,
      dailyDrawdownLimitPct: 5,
      maxDrawdownLimitPct: 10,
      profitSplitPct: 80,
    },
    {
      displayId: 'PFT-50K-77310',
      userId: nina.id,
      mt5Login: '7100773105',
      mt5Server: 'PFT-Live-Server-02',
      planSize: 50000,
      challengeType: 'ONE_STEP' as const,
      phase: 'FUNDED' as const,
      status: 'FUNDED' as const,
      leverage: '1:50',
      initialBalance: 50000,
      dailyStartingEquity: 52940,
      currentBalance: 53180,
      currentEquity: 53312.5,
      tradingDaysCount: 9,
      dailyDrawdownLimitPct: 4,
      maxDrawdownLimitPct: 6,
      profitSplitPct: 80,
    },
    {
      displayId: 'PFT-25K-55017',
      userId: erik.id,
      mt5Login: '5100550172',
      mt5Server: 'PFT-Demo-Server',
      planSize: 25000,
      challengeType: 'TWO_STEP' as const,
      phase: 'PHASE_2' as const,
      status: 'BREACHED_MAX' as const,
      leverage: '1:100',
      initialBalance: 25000,
      dailyStartingEquity: 23620,
      currentBalance: 22410,
      currentEquity: 22410,
      tradingDaysCount: 3,
      dailyDrawdownLimitPct: 5,
      maxDrawdownLimitPct: 10,
      profitSplitPct: 80,
      breachReason: 'Max overall loss exceeded 10%',
    },
    {
      displayId: 'PFT-200K-44102',
      userId: lana.id,
      mt5Login: '5100441028',
      mt5Server: 'PFT-Demo-Server',
      planSize: 200000,
      challengeType: 'TWO_STEP' as const,
      phase: 'PHASE_1' as const,
      status: 'ACTIVE' as const,
      leverage: '1:100',
      initialBalance: 200000,
      dailyStartingEquity: 201400,
      currentBalance: 194200,
      currentEquity: 193050,
      tradingDaysCount: 2,
      dailyDrawdownLimitPct: 5,
      maxDrawdownLimitPct: 10,
      profitSplitPct: 80,
    },
    {
      displayId: 'PFT-200K-11920',
      userId: theo.id,
      mt5Login: '5100119204',
      mt5Server: 'PFT-Live-Server-01',
      planSize: 400000,
      challengeType: 'ONE_STEP' as const,
      phase: 'PHASE_1' as const,
      status: 'ACTIVE' as const,
      leverage: '1:30',
      initialBalance: 400000,
      dailyStartingEquity: 372800,
      currentBalance: 366000,
      currentEquity: 365200,
      tradingDaysCount: 6,
      dailyDrawdownLimitPct: 4,
      maxDrawdownLimitPct: 6,
      profitSplitPct: 90,
    },
    {
      displayId: 'PFT-10K-33001',
      userId: nina.id,
      mt5Login: '5100330011',
      mt5Server: 'PFT-Demo-Server',
      planSize: 10000,
      challengeType: 'ONE_STEP' as const,
      phase: 'PHASE_1' as const,
      status: 'ACTIVE' as const,
      leverage: '1:100',
      initialBalance: 10000,
      dailyStartingEquity: 10180,
      currentBalance: 10240,
      currentEquity: 10255,
      tradingDaysCount: 3,
      dailyDrawdownLimitPct: 4,
      maxDrawdownLimitPct: 6,
      profitSplitPct: 80,
    },
    {
      displayId: 'PFT-100K-22018',
      userId: lana.id,
      mt5Login: '5100220186',
      mt5Server: 'PFT-Demo-Server',
      planSize: 100000,
      challengeType: 'TWO_STEP' as const,
      phase: 'PHASE_1' as const,
      status: 'BREACHED_DAILY' as const,
      leverage: '1:100',
      initialBalance: 100000,
      dailyStartingEquity: 101200,
      currentBalance: 96100,
      currentEquity: 95880,
      tradingDaysCount: 1,
      dailyDrawdownLimitPct: 5,
      maxDrawdownLimitPct: 10,
      profitSplitPct: 80,
      breachReason: 'Daily loss limit of 5% breached',
    },
  ]

  const created = []
  for (const book of books) {
    const metrics = recomputeMetrics(book)
    created.push(
      await prisma.tradingAccount.create({
        data: {
          ...book,
          ...metrics,
          profitSplitPct: book.profitSplitPct,
          lastTelemetryAt: new Date(),
        },
      }),
    )
  }

  const byDisplay = Object.fromEntries(created.map((row) => [row.displayId, row]))

  await prisma.trade.createMany({
    data: [
      {
        accountId: byDisplay['PFT-100K-98214'].id,
        ticket: '48221',
        symbol: 'XAUUSD',
        lots: 1.5,
        side: 'BUY',
        openPrice: 2648.15,
        openTime: new Date(Date.now() - 40 * 60_000),
        profit: 210,
        swap: -4.2,
        commission: -10.5,
        status: 'OPEN',
      },
      {
        accountId: byDisplay['PFT-100K-98214'].id,
        ticket: '48211',
        symbol: 'XAUUSD',
        lots: 1.5,
        side: 'BUY',
        openPrice: 2648.15,
        closePrice: 2652.4,
        openTime: new Date(Date.now() - 400 * 60_000),
        closeTime: new Date(Date.now() - 220 * 60_000),
        profit: 627,
        commission: -10.5,
        status: 'CLOSED',
      },
      {
        accountId: byDisplay['PFT-200K-44102'].id,
        ticket: '77102',
        symbol: 'NAS100',
        lots: 12,
        side: 'SELL',
        openPrice: 20184.3,
        openTime: new Date(Date.now() - 25 * 60_000),
        profit: -1840,
        swap: -12,
        commission: -12,
        status: 'OPEN',
      },
      {
        accountId: byDisplay['PFT-200K-11920'].id,
        ticket: '11991',
        symbol: 'EURUSD',
        lots: 18,
        side: 'BUY',
        openPrice: 1.08742,
        openTime: new Date(Date.now() - 70 * 60_000),
        profit: -4200,
        swap: -18,
        commission: -126,
        status: 'OPEN',
      },
      {
        accountId: byDisplay['PFT-50K-77310'].id,
        ticket: '31922',
        symbol: 'GBPUSD',
        lots: 1.2,
        side: 'SELL',
        openPrice: 1.31104,
        openTime: new Date(Date.now() - 15 * 60_000),
        profit: 84,
        swap: -1.1,
        commission: -8.4,
        status: 'OPEN',
      },
      {
        accountId: byDisplay['PFT-25K-55017'].id,
        ticket: '22914',
        symbol: 'XAUUSD',
        lots: 1.5,
        side: 'SELL',
        openPrice: 2639.2,
        closePrice: 2647.3,
        openTime: new Date(Date.now() - 1600 * 60_000),
        closeTime: new Date(Date.now() - 1560 * 60_000),
        profit: -1225.5,
        commission: -10.5,
        status: 'CLOSED',
        markedForLiquidation: true,
      },
    ],
  })

  await prisma.payout.createMany({
    data: [
      {
        userId: nina.id,
        accountId: byDisplay['PFT-50K-77310'].id,
        amount: 2548,
        profitSplitPct: 80,
        walletAddress: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5o4EqfQ',
        network: 'USDT_TRC20',
        status: 'PENDING',
        requestedAt: new Date(Date.now() - 210 * 60_000),
      },
      {
        userId: theo.id,
        accountId: byDisplay['PFT-200K-11920'].id,
        amount: 18200,
        profitSplitPct: 90,
        walletAddress: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
        network: 'USDT_ERC20',
        status: 'PENDING',
        requestedAt: new Date(Date.now() - 74 * 60_000),
      },
      {
        userId: nina.id,
        accountId: byDisplay['PFT-50K-77310'].id,
        amount: 1984,
        profitSplitPct: 80,
        walletAddress: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5o4EqfQ',
        network: 'USDT_TRC20',
        status: 'DISBURSED',
        txHash: '0x8f3a1c9e2b7d44aa91c0',
        requestedAt: new Date(Date.now() - 14 * 24 * 60 * 60_000),
        reviewedAt: new Date(Date.now() - 14 * 24 * 60 * 60_000 + 38 * 60_000),
      },
    ],
  })

  await prisma.order.create({
    data: {
      userId: marcus.id,
      accountId: byDisplay['PFT-100K-98214'].id,
      provider: 'cryptomus',
      providerOrderId: `PFT-${Date.now()}`,
      amount: 499,
      currency: 'USD',
      status: 'PAID',
    },
  })

  await prisma.telemetrySync.upsert({
    where: { id: 'global' },
    create: { id: 'global', lastSyncedAt: new Date(), lastStatus: 'ok', recordsUpdated: created.length },
    update: { lastSyncedAt: new Date(), lastStatus: 'ok', recordsUpdated: created.length },
  })

  console.log(`Seeded ops desk as ${admin.email} with ${created.length} trading books`)
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error)
    await prisma.$disconnect()
    process.exit(1)
  })
