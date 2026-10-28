import { prisma } from '@/lib/prisma'

/**
 * Aggregated read model for the minimalist "Payouts & Certificates" page.
 * Payouts come from the `Payout` model; certificates are derived from
 * successfully completed challenges (`PASSED_*` / `FUNDED` accounts).
 */

export type PayoutRow = {
  id: string
  accountId: string
  accountDisplayId: string
  amount: number
  profitSplitPct: number
  network: string
  status: 'PENDING' | 'APPROVED' | 'DISBURSED' | 'REJECTED'
  txHash: string | null
  rejectReason: string | null
  requestedAt: number
  reviewedAt: number | null
}

export type FundedAccountSummary = {
  id: string
  displayId: string
  profitSplitPct: number
  available: number
  eligibleAt: number | null
  cycleReferenceAt: number | null
}

export type CertificateCard = {
  id: string
  displayId: string
  kind: 'FUNDED' | 'PASSED_PHASE_1' | 'PASSED_PHASE_2'
  title: string
  planSize: number
  issuedAt: number
  statusLabel: string
}

export type PayoutsData = {
  payouts: PayoutRow[]
  totals: { withdrawn: number; pending: number }
  fundedAccounts: FundedAccountSummary[]
  certificates: CertificateCard[]
}

const PAYOUT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
const round2 = (value: number) => Math.round(value * 100) / 100

function networkLabel(network: string): string {
  if (network === 'USDT_TRC20') return 'USDT · TRC-20'
  if (network === 'USDT_ERC20') return 'USDT · ERC-20'
  return network
}

function certificateMeta(kind: CertificateCard['kind']) {
  switch (kind) {
    case 'FUNDED':
      return { title: 'Funded Trader Certificate', statusLabel: 'Funded' }
    case 'PASSED_PHASE_2':
      return { title: 'Phase 2 Evaluation Passed', statusLabel: 'Phase 2 passed' }
    default:
      return { title: 'Phase 1 Evaluation Passed', statusLabel: 'Phase 1 passed' }
  }
}

export async function getPayoutsData(userId: string): Promise<PayoutsData> {
  const accounts = await prisma.tradingAccount.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      displayId: true,
      planSize: true,
      status: true,
      initialBalance: true,
      currentBalance: true,
      profitSplitPct: true,
      updatedAt: true,
    },
  })

  const payouts = await prisma.payout.findMany({
    where: { userId },
    orderBy: { requestedAt: 'desc' },
    take: 50,
  })

  const firstTrades = await prisma.tradeHistory.groupBy({
    by: ['tradingAccountId'],
    where: { tradingAccountId: { in: accounts.map((account) => account.id) } },
    _min: { openedAt: true },
  })
  const firstTradeByAccount = new Map(
    firstTrades.map((row) => [row.tradingAccountId, row._min.openedAt]),
  )

  const payoutRows: PayoutRow[] = payouts.map((payout) => {
    const account = accounts.find((item) => item.id === payout.accountId)
    return {
      id: payout.id,
      accountId: payout.accountId,
      accountDisplayId: account?.displayId ?? payout.accountId,
      amount: round2(Number(payout.amount)),
      profitSplitPct: payout.profitSplitPct,
      network: networkLabel(payout.network),
      status: payout.status,
      txHash: payout.txHash,
      rejectReason: payout.rejectReason,
      requestedAt: payout.requestedAt.getTime(),
      reviewedAt: payout.reviewedAt ? payout.reviewedAt.getTime() : null,
    }
  })

  const withdrawn = round2(
    payouts.filter((payout) => payout.status === 'DISBURSED').reduce((sum, payout) => sum + Number(payout.amount), 0),
  )
  const pending = round2(
    payouts
      .filter((payout) => payout.status === 'PENDING' || payout.status === 'APPROVED')
      .reduce((sum, payout) => sum + Number(payout.amount), 0),
  )

  // Per funded account: available payout balance (mirrors the POST /api/payouts
  // formula) and the eligibility timer (7 full days after cycle reference).
  const fundedAccounts: FundedAccountSummary[] = []
  for (const account of accounts.filter((item) => item.status === 'FUNDED')) {
    const own = payouts.filter((payout) => payout.accountId === account.id)
    const paid = own
      .filter((payout) => payout.status === 'DISBURSED')
      .reduce((sum, payout) => sum + Number(payout.amount), 0)
    const reserved = own
      .filter((payout) => payout.status === 'PENDING' || payout.status === 'APPROVED')
      .reduce((sum, payout) => sum + Number(payout.amount), 0)
    const debited = own
      .filter((payout) => (payout.status === 'PENDING' || payout.status === 'APPROVED') && payout.balanceReserved)
      .reduce((sum, payout) => sum + Number(payout.amount), 0)

    const accumulatedProfit = Number(account.currentBalance) - Number(account.initialBalance) + paid + debited
    const profitShare = accumulatedProfit > 0 ? (accumulatedProfit * account.profitSplitPct) / 100 : 0
    const available = round2(Math.max(0, profitShare - paid - reserved))

    const lastDisbursed = own
      .filter((payout) => payout.status === 'DISBURSED')
      .sort((a, b) => {
        const aTime = a.reviewedAt ? a.reviewedAt.getTime() : a.requestedAt.getTime()
        const bTime = b.reviewedAt ? b.reviewedAt.getTime() : b.requestedAt.getTime()
        return bTime - aTime
      })[0]
    const cycleReference = lastDisbursed
      ? (lastDisbursed.reviewedAt?.getTime() ?? lastDisbursed.requestedAt.getTime())
      : (firstTradeByAccount.get(account.id)?.getTime() ?? null)

    fundedAccounts.push({
      id: account.id,
      displayId: account.displayId,
      profitSplitPct: account.profitSplitPct,
      available,
      eligibleAt: cycleReference ? cycleReference + PAYOUT_INTERVAL_MS : null,
      cycleReferenceAt: cycleReference,
    })
  }

  const certificates: CertificateCard[] = accounts
    .filter((account) => account.status === 'FUNDED' || account.status.startsWith('PASSED'))
    .map((account) => {
      const kind: CertificateCard['kind'] =
        account.status === 'FUNDED'
          ? 'FUNDED'
          : account.status === 'PASSED_PHASE_2'
            ? 'PASSED_PHASE_2'
            : 'PASSED_PHASE_1'
      const meta = certificateMeta(kind)
      return {
        id: account.id,
        displayId: account.displayId,
        kind,
        title: meta.title,
        planSize: account.planSize,
        issuedAt: account.updatedAt.getTime(),
        statusLabel: meta.statusLabel,
      }
    })

  return { payouts: payoutRows, totals: { withdrawn, pending }, fundedAccounts, certificates }
}
