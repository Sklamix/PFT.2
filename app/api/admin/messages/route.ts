import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'

export const dynamic = 'force-dynamic'

const AUDIENCES = ['ALL', 'ADMIN', 'RISK_MANAGER'] as const
type Audience = (typeof AUDIENCES)[number]

/** Lists staff broadcast messages, newest first, optionally filtered by audience class. */
export async function GET(request: Request) {
  const { error } = await requireAdmin()
  if (error) return error

  const audience = new URL(request.url).searchParams.get('audience') ?? 'ALL'
  if (!AUDIENCES.includes(audience as Audience)) {
    return jsonError('audience must be ALL, ADMIN or RISK_MANAGER.', 400)
  }

  const messages = await prisma.adminMessage.findMany({
    where: audience === 'ALL' ? {} : { audience: { in: [audience, 'ALL'] } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  return NextResponse.json({ messages })
}

/** Broadcasts a message to staff. Minor action — one admin, audited by the record itself. */
export async function POST(request: Request) {
  const { session, error } = await requireAdmin()
  if (error) return error

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const subject = typeof body.subject === 'string' ? body.subject.trim().slice(0, 120) : ''
  const text = typeof body.body === 'string' ? body.body.trim().slice(0, 4000) : ''
  const audience = typeof body.audience === 'string' && AUDIENCES.includes(body.audience as Audience) ? (body.audience as Audience) : 'ALL'

  if (subject.length < 3) return jsonError('Subject must be at least 3 characters.', 400)
  if (text.length < 10) return jsonError('Message body must be at least 10 characters.', 400)

  const message = await prisma.adminMessage.create({
    data: {
      subject,
      body: text,
      audience,
      createdById: session.sub,
      createdByName: session.name ?? session.email ?? 'Admin',
    },
  })

  return NextResponse.json({ message }, { status: 201 })
}
