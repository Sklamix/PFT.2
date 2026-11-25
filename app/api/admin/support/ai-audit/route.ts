import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/admin/auth'
import { handleSupportError } from '@/lib/support/http'
import { readSupportChatResult, type SupportChatResult } from '@/lib/ai/support-chat'

export const dynamic = 'force-dynamic'

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000

type AuditItem = {
  createdAt: string
  category: SupportChatResult['suggestedCategory']
  grounding: SupportChatResult['grounding'] | null
  /** Exposed for review only when the answer is not a grounded one. */
  answer: string | null
  citations: number[]
}

/**
 * Read-only review of AI support answers. Body is a hash/length for grounded
 * answers; full text only for ungrounded or forbidden verdicts (for review).
 */
export async function GET(request: Request) {
  const { error } = await requireAdmin()
  if (error) return error

  const rawLimit = new URL(request.url).searchParams.get('limit')
  const limit = rawLimit ? Math.min(200, Math.max(1, Number.parseInt(rawLimit, 10) || 50)) : 50

  try {
    const rows = await prisma.aiSupportRequest.findMany({
      where: { status: 'COMPLETED', createdAt: { gte: new Date(Date.now() - IDEMPOTENCY_TTL_MS) } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { createdAt: true, result: true },
    })

    const items: AuditItem[] = rows.map((row) => {
      const result = readSupportChatResult(row.result)
      return {
        createdAt: row.createdAt.toISOString(),
        category: result?.suggestedCategory ?? null,
        grounding: result?.grounding ?? null,
        // A grounded answer is never exposed; a blocked one is, so the reviewer can
        // see what the model actually tried to say.
        answer: result && result.grounding !== 'grounded' ? (result.reviewAnswer ?? null) : null,
        citations: result?.citations.map((citation) => citation.section) ?? [],
      }
    })

    return NextResponse.json({ items }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (cause) {
    return handleSupportError(cause)
  }
}
