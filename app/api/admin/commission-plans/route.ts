import { NextResponse } from 'next/server'
import { requireAdmin, requireStaff } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { createCommissionPlanVersion } from '@/lib/finance/commission-plans'
import type { CommissionModel } from '@/lib/finance/commission'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

const MODELS: readonly CommissionModel[] = ['PER_LOT', 'PER_DEAL', 'PERCENT_NOTIONAL']

function asModel(value: unknown): CommissionModel | null {
  return typeof value === 'string' && MODELS.includes(value as CommissionModel) ? (value as CommissionModel) : null
}

export async function GET(request: Request) {
  const { error } = await requireStaff()
  if (error) return error

  try {
    const instrumentId = new URL(request.url).searchParams.get('instrumentId') ?? undefined
    const plans = await prisma.commissionPlan.findMany({
      where: instrumentId ? { instrumentId } : undefined,
      include: { instrument: { select: { symbol: true, terminalSymbol: true, category: true } } },
      orderBy: [{ instrumentId: 'asc' }, { effectiveFrom: 'desc' }],
      take: 500,
    })
    return NextResponse.json({
      plans: plans.map((plan) => ({
        id: plan.id,
        instrumentId: plan.instrumentId,
        symbol: plan.instrument.terminalSymbol ?? plan.instrument.symbol,
        category: plan.instrument.category,
        model: plan.model,
        entryRate: plan.entryRate.toString(),
        exitRate: plan.exitRate.toString(),
        currency: plan.currency,
        minFee: plan.minFee?.toString() ?? null,
        maxFee: plan.maxFee?.toString() ?? null,
        effectiveFrom: plan.effectiveFrom.toISOString(),
        isActive: plan.isActive,
        zeroFeeApproved: plan.zeroFeeApproved,
        source: plan.source,
        createdBy: plan.createdBy,
        createdAt: plan.createdAt.toISOString(),
      })),
    })
  } catch (err) {
    return safeError(err)
  }
}

export async function POST(request: Request) {
  const { session, error } = await requireAdmin()
  if (error) return error

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return jsonError('Invalid JSON body')

  const instrumentId = typeof body.instrumentId === 'string' ? body.instrumentId.trim() : ''
  const model = asModel(body.model)
  if (!instrumentId) return jsonError('instrumentId is required')
  if (!model) return jsonError('model must be PER_LOT, PER_DEAL or PERCENT_NOTIONAL')

  const entryRate = typeof body.entryRate === 'number' || typeof body.entryRate === 'string' ? body.entryRate : null
  const exitRate = typeof body.exitRate === 'number' || typeof body.exitRate === 'string' ? body.exitRate : null
  if (entryRate == null || exitRate == null) return jsonError('entryRate and exitRate are required')

  const minFee = typeof body.minFee === 'number' || typeof body.minFee === 'string' ? body.minFee : null
  const maxFee = typeof body.maxFee === 'number' || typeof body.maxFee === 'string' ? body.maxFee : null
  const source = typeof body.source === 'string' ? body.source.slice(0, 120) : 'ADMIN'
  const zeroFeeApproved = body.zeroFeeApproved === true

  try {
    const result = await prisma.$transaction(async (tx) => {
      const created = await createCommissionPlanVersion(
        tx,
        { instrumentId, model, entryRate, exitRate, minFee, maxFee, source, zeroFeeApproved },
        session?.sub ?? null,
      )
      if (!created.ok) return created
      await tx.auditLog.create({
        data: {
          actorId: session?.sub ?? null,
          action: 'COMMISSION_PLAN_VERSION_CREATED',
          reason: 'Commission tariff version created',
          metadata: { instrumentId, model, entryRate, exitRate, minFee, maxFee, zeroFeeApproved, planId: created.planId },
        },
      })
      return created
    })
    if (!result.ok) return jsonError(result.error)
    return NextResponse.json({ ok: true, planId: result.planId }, { status: 201 })
  } catch (err) {
    return safeError(err)
  }
}
