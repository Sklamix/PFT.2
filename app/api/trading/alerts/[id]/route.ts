import { NextResponse } from 'next/server'
import { requireTrader } from '@/lib/trader/auth'
import { prisma } from '@/lib/prisma'
import { ALERTS_NOT_ENABLED_MESSAGE, isMissingSchema } from '@/lib/alerts/schema-guard'

export const dynamic = 'force-dynamic'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { session, error } = await requireTrader()
  if (error) return error

  const { id } = await params

  let result: { count: number }
  try {
    result = await prisma.priceAlert.updateMany({
      where: { id, userId: session.sub, status: 'ACTIVE' },
      data: { status: 'CANCELLED' },
    })
  } catch (error) {
    if (isMissingSchema(error)) {
      return NextResponse.json({ error: ALERTS_NOT_ENABLED_MESSAGE }, { status: 503 })
    }
    throw error
  }

  if (result.count === 0) {
    return NextResponse.json({ error: 'Alert not found' }, { status: 404 })
  }

  return NextResponse.json({ ok: true })
}
