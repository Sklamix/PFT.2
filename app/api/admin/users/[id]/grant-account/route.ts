import { NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/prisma'
import { provisionChallengeAccounts, type ChallengePlan } from '@/lib/provisioning/challenge-account'
import { fundingResetData } from '@/lib/trading/funding'
import { CHALLENGES } from '@/lib/challenges'
import { AccountLimitError } from '@/lib/accounts/limits'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'

export const dynamic = 'force-dynamic'

const PLAN_SIZES = [1_000, 3_000, 5_000, 10_000, 25_000, 50_000, 100_000, 200_000]

/**
 * Grants a registered trader a new account of any type. This is a minor action:
 * a single admin executes it and the grant is audited, with no second-admin
 * approval round-trip.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin()
  if (error) return error
  if (session.role !== 'ADMIN') {
    return jsonError('Only an admin can grant trading accounts.', 403)
  }

  try {
    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    const planSize = Number(body.planSize)
    if (!PLAN_SIZES.includes(planSize)) {
      return jsonError(`planSize must be one of: ${PLAN_SIZES.join(', ')}.`, 400)
    }
    const challengeInput = body.challengeType
    if (challengeInput !== '1-Step' && challengeInput !== '2-Step') {
      return jsonError('challengeType must be 1-Step or 2-Step.', 400)
    }
    const grantAs = body.grantAs
    if (grantAs !== 'evaluation' && grantAs !== 'funded') {
      return jsonError('grantAs must be evaluation or funded.', 400)
    }
    const drawdownMode = body.drawdownMode === 'static' ? 'static' : 'trailing'
    const hasFrozenBackup = body.hasFrozenBackup === true
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (reason.length < 4) {
      return jsonError('A short reason (min 4 characters) is required for the audit trail.', 400)
    }

    const trader = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true } })
    if (!trader) return jsonError('Trader not found.', 404)

    const plan: ChallengePlan = {
      planSize,
      challengeType: challengeInput === '1-Step' ? 'one-step' : 'two-step',
      drawdownMode,
      dailyLossType: CHALLENGES[challengeInput === '1-Step' ? 'one-step' : 'two-step'].dailyDrawdown,
      hasFrozenBackup,
    }

    const result = await prisma.$transaction(async (tx) => {
      const provisioned = await provisionChallengeAccounts(
        tx,
        {
          userId: id,
          orderId: `admin-grant-${randomUUID()}`,
          providerOrderId: `admin-grant-${randomUUID()}`,
          plan,
        },
        { skipAllocationLimit: true },
      )

      if (grantAs === 'funded') {
        await tx.tradingAccount.update({
          where: { id: provisioned.primary.id },
          data: {
            ...fundingResetData(planSize),
            profitSplitPct: 80,
          },
        })
      }

      await tx.auditLog.create({
        data: {
          actorId: session.sub,
          accountId: provisioned.primary.id,
          action: 'ACCOUNT_ADMIN_GRANTED',
          reason,
          metadata: {
            planSize,
            challengeType: challengeInput,
            drawdownMode,
            grantAs,
            hasFrozenBackup,
            standbyId: provisioned.standby?.id ?? null,
          },
        },
      })

      return provisioned
    })

    return NextResponse.json({
      account: {
        id: result.primary.id,
        displayId: result.primary.displayId,
        status: grantAs === 'funded' ? 'FUNDED' : result.primary.status,
      },
      standby: result.standby?.displayId ?? null,
    }, { status: 201 })
  } catch (err) {
    if (err instanceof AccountLimitError) {
      return jsonError(err.message, 400)
    }
    return safeError(err)
  }
}
