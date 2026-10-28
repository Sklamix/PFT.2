import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireTrader } from '@/lib/trader/auth'

export const dynamic = 'force-dynamic'

const MAX_SCREENSHOT_BYTES = 600 * 1024
const MAX_TAGS = 8
const MAX_NOTE_LENGTH = 4000

function parseTags(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null
  const tags = input
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim().slice(0, 30))
    .filter(Boolean)
  if (tags.length > MAX_TAGS) return null
  return [...new Set(tags)]
}

/** Creates or updates the trader's journal record for one closed trade. */
export async function PATCH(request: Request, { params }: { params: Promise<{ tradeId: string }> }) {
  const { session, error } = await requireTrader()
  if (error) return error

  const { tradeId } = await params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 })
  }
  const input = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>

  const note = typeof input.note === 'string' ? input.note.slice(0, MAX_NOTE_LENGTH) : undefined
  const tags = input.tags === undefined ? undefined : parseTags(input.tags)
  if (input.tags !== undefined && tags === null) {
    return NextResponse.json({ error: `At most ${MAX_TAGS} tags are allowed.` }, { status: 400 })
  }

  let screenshot: string | null | undefined
  if (input.screenshot === null) {
    screenshot = null
  } else if (typeof input.screenshot === 'string' && input.screenshot.startsWith('data:image/')) {
    if (input.screenshot.length > MAX_SCREENSHOT_BYTES) {
      return NextResponse.json({ error: 'Screenshot is too large (max 600 KB).' }, { status: 400 })
    }
    screenshot = input.screenshot
  } else if (input.screenshot !== undefined) {
    return NextResponse.json({ error: 'screenshot must be an image data URL or null.' }, { status: 400 })
  }

  try {
    // Ownership: the trade must belong to one of the trader's accounts.
    const trade = await prisma.tradeHistory.findUnique({
      where: { id: tradeId },
      select: { tradingAccount: { select: { userId: true } } },
    })
    if (!trade || trade.tradingAccount.userId !== session.sub) {
      return NextResponse.json({ error: 'Trade not found.' }, { status: 404 })
    }

    const entry = await prisma.journalEntry.upsert({
      where: { tradeId },
      create: {
        tradeId,
        userId: session.sub,
        note: note ?? '',
        tags: JSON.stringify(tags ?? []),
        ...(screenshot !== undefined ? { screenshot } : {}),
      },
      update: {
        ...(note !== undefined ? { note } : {}),
        ...(tags !== undefined ? { tags: JSON.stringify(tags) } : {}),
        ...(screenshot !== undefined ? { screenshot } : {}),
      },
    })

    return NextResponse.json({
      tradeId,
      note: entry.note,
      tags: (() => {
        try {
          const parsed = JSON.parse(entry.tags)
          return Array.isArray(parsed) ? parsed : []
        } catch {
          return []
        }
      })(),
      screenshot: entry.screenshot,
    })
  } catch (err) {
    console.error('[pft journal-entry]', err)
    return NextResponse.json({ error: 'Unable to save journal entry.' }, { status: 500 })
  }
}
