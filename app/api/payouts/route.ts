import { Prisma, WalletNetwork } from '@prisma/client'
import { NextResponse } from 'next/server'
import { recomputeMetrics } from '@/lib/admin/risk'
import { prisma } from '@/lib/prisma'
import { requireTrader } from '@/lib/trader/auth'

export const dynamic = 'force-dynamic'

function parseAmount(value: unknown): Prisma.Decimal | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const amount = String(value)
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(amount)) return null
  const parsed = new Prisma.Decimal(amount)
  return parsed.greaterThan(0) ? parsed : null
}

function validWalletAddress(network: WalletNetwork, address: string) {
  if (network === 'USDT_TRC20') return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)
  return /^0x[a-fA-F0-9]{40}$/.test(address)
}

function roundDownToCents(value: Prisma.Decimal) {
  return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN)
}

export async function POST(request: Request) {
  const { session, error } = await requireTrader()
  if (error) return error

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 })
  }

  const input = body as Record<string, unknown>
  const accountId = typeof input.accountId === 'string' ? input.accountId.trim() : ''
  const walletAddress = typeof input.walletAddress === 'string' ? input.walletAddress.trim() : ''
  const amount = parseAmount(input.amount)
  const network =
    input.network === 'USDT_TRC20' || input.network === 'USDT_ERC20'
      ? input.network
      : undefined

  if (!accountId) return NextResponse.json({ error: 'accountId is required.' }, { status: 400 })
  if (!amount) {
    return NextResponse.json({ error: 'amount must be a positive number with at most two decimals.' }, { status: 400 })
  }
  if (!network) {
    return NextResponse.json({ error: 'network must be USDT_TRC20 or USDT_ERC20.' }, { status: 400 })
  }
  if (!validWalletAddress(network, walletAddress)) {
    return NextResponse.json({ error: 'walletAddress is invalid for the selected network.' }, { status: 400 })
  }
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'Payout requests require a configured database.' }, { status: 503 })
  }

  try {
    const payout = await prisma.$transaction(async (tx) => {
      const account = await tx.tradingAccount.findFirst({
        where: { id: accountId, userId: session.sub, status: 'FUNDED' },
        select: {
          id: true,
          userId: true,
          status: true,
          initialBalance: true,
          dailyStartingEquity: true,
          currentBalance: true,
          currentEquity: true,
          balance: true,
          equity: true,
          peakEquity: true,
          profitSplitPct: true,
          reservedPayoutAmount: true,
        },
      })
      if (!account) return { error: 'FUNDED_ACCOUNT_NOT_FOUND' as const }

      const [reserved, paid] = await Promise.all([
        tx.payout.aggregate({
          where: { accountId, status: { in: ['PENDING', 'APPROVED'] } },
          _sum: { amount: true },
        }),
        tx.payout.aggregate({
          where: { accountId, status: 'DISBURSED' },
          _sum: { amount: true },
        }),
      ])
      const previouslyDebited = await tx.payout.aggregate({
        where: { accountId, status: { in: ['PENDING', 'APPROVED'] }, balanceReserved: true },
        _sum: { amount: true },
      })
      const reservedAmount = reserved._sum.amount ?? new Prisma.Decimal(0)
      const paidAmount = paid._sum.amount ?? new Prisma.Decimal(0)
      const debitedAmount = previouslyDebited._sum.amount ?? new Prisma.Decimal(0)
      const accumulatedProfit = account.currentBalance
        .minus(account.initialBalance)
        .plus(paidAmount)
        .plus(debitedAmount)
      const profitShare = roundDownToCents(
        accumulatedProfit
          .greaterThan(0)
          ? accumulatedProfit.mul(account.profitSplitPct).div(100)
          : new Prisma.Decimal(0),
      )
      const available = profitShare.minus(paidAmount).minus(reservedAmount)
      if (amount.greaterThan(available)) {
        return {
          error: 'INSUFFICIENT_PAYOUT_BALANCE' as const,
          available: available.greaterThan(0) ? available.toFixed(2) : '0.00',
        }
      }

      const reservedBalance = await tx.tradingAccount.updateMany({
        where: {
          id: account.id,
          userId: session.sub,
          status: 'FUNDED',
          reservedPayoutAmount: account.reservedPayoutAmount,
          currentBalance: account.currentBalance,
          currentEquity: account.currentEquity,
          balance: account.balance,
          equity: account.equity,
          dailyStartingEquity: account.dailyStartingEquity,
          peakEquity: account.peakEquity,
        },
        data: {
          reservedPayoutAmount: reservedAmount.plus(amount),
          currentBalance: { decrement: amount },
          currentEquity: { decrement: amount },
          balance: { decrement: amount.toNumber() },
          equity: { decrement: amount.toNumber() },
          dailyStartingEquity: { decrement: amount },
          peakEquity: Math.max(
            Number(account.initialBalance),
            account.peakEquity - amount.toNumber(),
          ),
          ...recomputeMetrics({
            initialBalance: Number(account.initialBalance),
            dailyStartingEquity: Number(account.dailyStartingEquity.minus(amount)),
            currentEquity: Number(account.currentEquity.minus(amount)),
          }),
        },
      })
      if (reservedBalance.count !== 1) return { error: 'PAYOUT_BALANCE_CHANGED' as const }

      const row = await tx.payout.create({
        data: {
          userId: account.userId,
          accountId: account.id,
          amount,
          profitSplitPct: account.profitSplitPct,
          walletAddress,
          network,
          status: 'PENDING',
          balanceReserved: true,
        },
        select: {
          id: true,
          amount: true,
          network: true,
          status: true,
          requestedAt: true,
        },
      })
      await tx.auditLog.create({
        data: {
          actorId: session.sub,
          accountId: account.id,
          action: 'PAYOUT_REQUESTED',
          metadata: { payoutId: row.id, amount: amount.toFixed(2), network },
        },
      })
      return { payout: row }
    })

    if ('error' in payout) {
      if (payout.error === 'FUNDED_ACCOUNT_NOT_FOUND') {
        return NextResponse.json({ error: 'Funded account not found.' }, { status: 404 })
      }
      if (payout.error === 'INSUFFICIENT_PAYOUT_BALANCE') {
        return NextResponse.json(
          { error: 'Requested amount exceeds your available payout balance.', available: payout.available },
          { status: 400 },
        )
      }
      return NextResponse.json(
        { error: 'Your payout balance changed. Refresh your account and try again.' },
        { status: 409 },
      )
    }

    return NextResponse.json({ payout: payout.payout }, { status: 201 })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
      return NextResponse.json(
        { error: 'Your payout balance changed. Refresh your account and try again.' },
        { status: 409 },
      )
    }
    console.error('[pft payouts] Request creation failed', err)
    return NextResponse.json({ error: 'Unable to create payout request.' }, { status: 500 })
  }
}
