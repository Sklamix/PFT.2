import { NextResponse } from 'next/server'
import { tradingRepo } from '@/lib/trading/repository'
import { requireTrader } from '@/lib/trader/auth'
import { accountOwnerId } from '@/lib/trader/accounts'

const notFound = () => NextResponse.json({ error: 'Trading account not found' }, { status: 404 })

/** Requires a trader session that owns `accountId`; foreign accounts answer 404 so ids can't be probed. */
export async function authorizeAccount(accountId: string) {
  const { session, error } = await requireTrader()
  if (error) return { session: null, error }
  if ((await accountOwnerId(accountId)) !== session.sub) return { session: null, error: notFound() }
  return { session, error: null }
}

export async function authorizePosition(positionId: string) {
  const { session, error } = await requireTrader()
  if (error) return { session: null, error }
  const accountId = await tradingRepo.positionAccountId(positionId)
  if (!accountId) return { session: null, error: NextResponse.json({ error: 'Position not found' }, { status: 404 }) }
  return authorizeAccount(accountId)
}
