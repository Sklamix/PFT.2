import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/admin/auth'
import { handleSupportError } from '@/lib/support/http'

export const dynamic = 'force-dynamic'

const HANDOFF_SUBJECT_PREFIX = 'Support chat:'

/** Persistent queue counts only; these do not estimate AI quality or provider health. */
export async function GET() {
  const { error } = await requireAdmin()
  if (error) return error

  try {
    const since = new Date(Date.now() - 24 * 60 * 60_000)
    const [openTickets, waitingForStaff, supportChatTickets24h] = await Promise.all([
      prisma.supportTicket.count({ where: { status: 'OPEN' } }),
      prisma.supportTicket.count({ where: { status: 'WAITING_FOR_STAFF' } }),
      prisma.supportTicket.count({
        where: { subject: { startsWith: HANDOFF_SUBJECT_PREFIX }, createdAt: { gte: since } },
      }),
    ])

    return NextResponse.json(
      { openTickets, waitingForStaff, supportChatTickets24h, asOf: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (cause) {
    return handleSupportError(cause)
  }
}
