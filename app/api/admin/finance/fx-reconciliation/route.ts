import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import {
  FX_RATE_SOURCES,
  listFxReconciliations,
  resolveFxReconciliation,
  type ResolveFxInput,
} from '@/lib/finance/fx-reconciliation'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

const MAX_VERSION = 1000

/** Paginated reconciliation queue, bounded to 50 rows per request. */
export async function GET(request: Request) {
  const { error } = await requireAdmin()
  if (error) return error
  try {
    const url = new URL(request.url)
    const accountId = url.searchParams.get('accountId')?.trim() || undefined
    const statusParam = url.searchParams.get('status')?.trim().toUpperCase()
    const status =
      statusParam === 'UNRESOLVED' || statusParam === 'RESOLVED' || statusParam === 'VOIDED'
        ? statusParam
        : undefined
    const limit = Number(url.searchParams.get('limit') ?? 25)
    const cursor = url.searchParams.get('cursor')?.trim() || null
    const rows = await listFxReconciliations({ accountId, status, limit, cursor })
    return NextResponse.json({
      rows: rows.map((row) => ({
        ...row,
        amountQuote: row.amountQuote.toString(),
        appliedAmountUsd: row.appliedAmountUsd.toString(),
        resolutionRate: row.resolutionRate?.toString() ?? null,
      })),
      nextCursor: rows.length === Math.max(1, Math.min(limit || 25, 50)) ? rows[rows.length - 1]?.id ?? null : null,
      rateSources: FX_RATE_SOURCES,
    })
  } catch (cause) {
    return safeError(cause)
  }
}

/**
 * Dry-run by default. A write requires `apply: true` and `confirm: true`.
 * The resolver never fetches a current market rate; a historical rate, pair, source
 * and timestamp must be supplied and are validated before any balance change.
 */
export async function POST(request: Request) {
  const { session, error } = await requireAdmin()
  if (error) return error
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return jsonError('Invalid JSON body')

    const reconciliationId = typeof body.reconciliationId === 'string' ? body.reconciliationId.trim() : ''
    if (!reconciliationId) return jsonError('reconciliationId is required')

    const record = await prisma.fxReconciliation.findUnique({
      where: { id: reconciliationId },
      select: { id: true, accountId: true, quoteCurrency: true, status: true },
    })
    if (!record) return jsonError('Reconciliation record not found.', 404)

    const suppliedUserId = typeof body.userId === 'string' && body.userId.trim() ? body.userId.trim() : null
    if (suppliedUserId) {
      const account = await prisma.tradingAccount.findUnique({
        where: { id: record.accountId },
        select: { userId: true },
      })
      if (!account || account.userId !== suppliedUserId) {
        return jsonError('Account does not belong to this trader.', 403)
      }
    }

    const apply = body.apply === true
    const confirm = body.confirm === true
    if (apply && !confirm) return jsonError('FX resolution requires explicit confirm: true', 400)

    const rate = body.rate
    if (typeof rate !== 'number' && typeof rate !== 'string') return jsonError('rate is required', 422)
    const rateNumber = typeof rate === 'number' ? rate : Number(rate)
    if (!Number.isFinite(rateNumber) || rateNumber <= 0) return jsonError('rate must be a positive number', 422)
    const ratePair = typeof body.ratePair === 'string' ? body.ratePair.trim() : null
    const rateSource = typeof body.rateSource === 'string' ? body.rateSource.trim() : ''
    const referenceRateRaw = body.referenceRate
    let referenceRate: number | string | null = null
    if (referenceRateRaw != null && referenceRateRaw !== '') {
      if (typeof referenceRateRaw !== 'number' && typeof referenceRateRaw !== 'string') {
        return jsonError('referenceRate must be a positive number', 422)
      }
      const referenceNumber = typeof referenceRateRaw === 'number' ? referenceRateRaw : Number(referenceRateRaw)
      if (!Number.isFinite(referenceNumber) || referenceNumber <= 0) {
        return jsonError('referenceRate must be a positive number', 422)
      }
      referenceRate = referenceRateRaw
    }
    const referenceSource = typeof body.referenceSource === 'string' ? body.referenceSource.trim() : null
    const rateTimestampRaw = typeof body.rateTimestamp === 'string' ? body.rateTimestamp : ''
    const rateTimestamp = new Date(rateTimestampRaw)
    if (!rateTimestampRaw || Number.isNaN(rateTimestamp.getTime())) {
      return jsonError('rateTimestamp must be a valid ISO date')
    }
    if (!ratePair) return jsonError('ratePair is required (for example GBP/USD)')
    if (!(FX_RATE_SOURCES as readonly string[]).includes(rateSource)) {
      return jsonError(`rateSource must be one of ${FX_RATE_SOURCES.join(', ')}`)
    }
    if (referenceSource != null && !(FX_RATE_SOURCES as readonly string[]).includes(referenceSource)) {
      return jsonError(`referenceSource must be one of ${FX_RATE_SOURCES.join(', ')}`)
    }

    const mode = body.mode === 'CORRECT' ? 'CORRECT' : 'APPLY'
    const version = Math.min(Math.max(Number(body.version ?? 1) || 1, 1), MAX_VERSION)
    const note = typeof body.note === 'string' ? body.note.slice(0, 500) : null

    const input: ResolveFxInput = {
      rate,
      ratePair,
      rateSource,
      referenceRate,
      referenceSource,
      rateTimestamp,
      note,
      apply,
      mode,
      version,
      resolvedBy: session.sub,
    }
    const result = await resolveFxReconciliation(reconciliationId, input)
    if (!result.ok) {
      return NextResponse.json({ ok: false, reason: result.reason }, { status: result.reason === 'not_found' ? 404 : 422 })
    }
    return NextResponse.json({
      ok: true,
      applied: result.plan.applied,
      dryRun: !apply,
      plan: {
        ...result.plan,
        amountQuote: result.plan.amountQuote.toString(),
        appliedAmountUsd: result.plan.appliedAmountUsd.toString(),
        rate: result.plan.rate.toString(),
        grossPnlUsd: result.plan.grossPnlUsd.toString(),
        netPnl: result.plan.netPnl.toString(),
        adjustment: result.plan.adjustment.toString(),
        entryCommission: result.plan.entryCommission?.toString() ?? null,
        exitCommission: result.plan.exitCommission?.toString() ?? null,
      },
    })
  } catch (cause) {
    return safeError(cause)
  }
}
