import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { createLedgerBaseline, reconstructAccountBalance } from '@/lib/finance/baseline'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

const MAX_VERSION = 1000

async function loadOwnedAccount(accountId: string, userId: string | null) {
  const account = await prisma.tradingAccount.findUnique({
    where: { id: accountId },
    select: { id: true, userId: true, displayId: true, status: true, archivedAt: true },
  })
  if (!account) return { error: 'Account not found.', status: 404 as const }
  if (userId && account.userId !== userId) return { error: 'Account does not belong to this trader.', status: 403 as const }
  return { account }
}

/** Dry-run report: balance reconstruction, unresolved FX, pending payouts, blockers. */
export async function GET(request: Request) {
  const { error } = await requireAdmin()
  if (error) return error
  try {
    const url = new URL(request.url)
    const accountId = (url.searchParams.get('accountId') ?? '').trim()
    const userId = url.searchParams.get('userId')?.trim() || null
    const version = Math.min(Math.max(Number(url.searchParams.get('version') ?? 1) || 1, 1), MAX_VERSION)
    if (!accountId) return jsonError('accountId is required')
    const owned = await loadOwnedAccount(accountId, userId)
    if ('error' in owned) return jsonError(owned.error ?? 'Account not found.', Number(owned.status ?? 404))

    const [reconstruction, plan] = await Promise.all([
      reconstructAccountBalance(accountId),
      createLedgerBaseline(accountId, { apply: false, version }),
    ])
    return NextResponse.json({
      dryRun: true,
      account: owned.account,
      reconstruction,
      plan,
    })
  } catch (cause) {
    return safeError(cause)
  }
}

/**
 * Explicit baseline application. Writes only when `apply` and `confirm` are both true.
 * Never runs automatically, never touches the account balance, never overwrites a baseline.
 */
export async function POST(request: Request) {
  const { session, error } = await requireAdmin()
  if (error) return error
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return jsonError('Invalid JSON body')
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : ''
    const userId = typeof body.userId === 'string' && body.userId.trim() ? body.userId.trim() : null
    const apply = body.apply === true
    const confirm = body.confirm === true
    const version = Math.min(Math.max(Number(body.version ?? 1) || 1, 1), MAX_VERSION)
    const source = typeof body.source === 'string' ? body.source.slice(0, 80) : 'LEGACY_BASELINE'
    const sourceReference = typeof body.sourceReference === 'string' ? body.sourceReference.slice(0, 240) : null
    if (!accountId) return jsonError('accountId is required')
    if (apply && !confirm) {
      return jsonError('Baseline application requires explicit confirm: true', 400)
    }

    const owned = await loadOwnedAccount(accountId, userId)
    if ('error' in owned) return jsonError(owned.error ?? 'Account not found.', Number(owned.status ?? 404))
    if (owned.account.archivedAt) return jsonError('Archived accounts cannot receive a new baseline', 409)

    const plan = await createLedgerBaseline(accountId, {
      apply,
      version,
      source,
      sourceReference,
      createdBy: session.sub,
    })

    if (apply && !plan.canCreate) {
      return NextResponse.json(
        {
          applied: false,
          reason: plan.existing ? 'Baseline already exists for this version' : 'Baseline blocked',
          plan,
        },
        { status: plan.existing ? 409 : 422 },
      )
    }

    return NextResponse.json({ applied: apply, plan })
  } catch (cause) {
    return safeError(cause)
  }
}
