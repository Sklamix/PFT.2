import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireTrader } from '@/lib/trader/auth'

export const dynamic = 'force-dynamic'

const MAX_NAME_LENGTH = 40

/** Renames a trader's own account (custom alias shown instead of the system displayId). */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireTrader()
  if (error) return error

  const { id } = await params
  if (!id) return NextResponse.json({ error: 'Account id is required.' }, { status: 400 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 })
  }
  const input = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>

  const rawName = typeof input.customName === 'string' ? input.customName.trim() : ''
  // Empty string clears the alias and falls back to the system displayId.
  const customName = rawName ? rawName.slice(0, MAX_NAME_LENGTH) : null
  if (rawName.length > MAX_NAME_LENGTH) {
    return NextResponse.json({ error: `Custom name must be ${MAX_NAME_LENGTH} characters or fewer.` }, { status: 400 })
  }

  try {
    const account = await prisma.tradingAccount.updateMany({
      where: { id, userId: session.sub },
      data: { customName },
    })
    if (account.count === 0) {
      return NextResponse.json({ error: 'Trading account not found.' }, { status: 404 })
    }
    return NextResponse.json({ id, customName })
  } catch (err) {
    console.error('[pft account-rename]', err)
    return NextResponse.json({ error: 'Unable to rename account.' }, { status: 500 })
  }
}
