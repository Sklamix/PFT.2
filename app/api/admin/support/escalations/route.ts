import { NextResponse } from 'next/server'
import { listActiveEscalations } from '@/lib/ai/agent-tools'
import { requireSupportRead } from '@/lib/support/http'
import { handleSupportError } from '@/lib/support/http'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' } as const

/**
 * Senior-tier queue: active agent escalations, oldest first, with the ticket
 * they belong to. The owner acts here and then closes the escalation.
 */
export async function GET() {
  const { error } = await requireSupportRead()
  if (error) return error

  try {
    const escalations = await listActiveEscalations()
    const tickets = await prisma.supportTicket.findMany({
      where: { publicId: { in: escalations.map((item) => item.publicId) } },
      select: {
        publicId: true,
        subject: true,
        category: true,
        status: true,
        priority: true,
        updatedAt: true,
        user: { select: { name: true, email: true } },
      },
    })
    const byPublicId = new Map(tickets.map((ticket) => [ticket.publicId, ticket]))
    return NextResponse.json(
      {
        items: escalations
          .map((escalation) => ({ escalation, ticket: byPublicId.get(escalation.publicId) ?? null }))
          // Oldest escalations first — the queue is worked top down.
          .sort((a, b) => new Date(a.escalation.raisedAt).getTime() - new Date(b.escalation.raisedAt).getTime()),
      },
      { headers: NO_STORE },
    )
  } catch (cause) {
    return handleSupportError(cause)
  }
}
