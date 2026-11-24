import { NextResponse } from 'next/server'
import { requireTrader } from '@/lib/trader/auth'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { session, error } = await requireTrader()
  if (error) return error

  const { id } = await params

  const result = await prisma.priceAlert.updateMany({
    where: { id, userId: session.sub, status: 'ACTIVE' },
    data: { status: 'CANCELLED' },
  })

  if (result.count === 0) {
    return NextResponse.json({ error: 'Alert not found' }, { status: 404 })
  }

  return NextResponse.json({ ok: true })
}
