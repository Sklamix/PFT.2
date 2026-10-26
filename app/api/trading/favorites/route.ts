import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { TERMINAL_SYMBOLS, type TerminalSymbolId } from '@/lib/constants/symbols'
import { requireTrader } from '@/lib/trader/auth'

export const dynamic = 'force-dynamic'

function sanitize(value: unknown): TerminalSymbolId[] {
  if (!Array.isArray(value)) return []
  const valid = new Set<string>(TERMINAL_SYMBOLS)
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && valid.has(item)))].slice(0, 80) as TerminalSymbolId[]
}

export async function GET() {
  const { session, error } = await requireTrader()
  if (error) return error
  try {
    const user = await prisma.user.findUnique({
      where: { id: session.sub },
      select: { favoriteSymbols: true },
    })
    return NextResponse.json(
      { favorites: sanitize(user?.favoriteSymbols ?? []) },
      { headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
    )
  } catch (cause) {
    console.error('Failed to load favorite symbols', cause)
    return NextResponse.json({ error: 'Unable to load favorite symbols.' }, { status: 500 })
  }
}

export async function PUT(request: Request) {
  const { session, error } = await requireTrader()
  if (error) return error
  try {
    const body = (await request.json().catch(() => null)) as { favorites?: unknown } | null
    const favorites = sanitize(body?.favorites)
    await prisma.user.update({
      where: { id: session.sub },
      data: { favoriteSymbols: favorites },
      select: { id: true },
    })
    return NextResponse.json({ favorites })
  } catch (cause) {
    console.error('Failed to save favorite symbols', cause)
    return NextResponse.json({ error: 'Unable to save favorite symbols.' }, { status: 500 })
  }
}
