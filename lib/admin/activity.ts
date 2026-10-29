import { prisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'

/**
 * Activity log for traders and staff.
 *
 * Entries are stored in the existing AuditLog table (actor, action, reason,
 * metadata, createdAt) so they survive alongside operational audits and can be
 * reviewed from the admin desk. Writes are best-effort: logging must never block
 * a trader action or an admin operation.
 */

export type ActivityScope = 'trader' | 'staff'

const STAFF_ROLES = ['ADMIN', 'RISK_MANAGER', 'SUPPORT'] as const

function ipFrom(request: Request | null) {
  if (!request) return null
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]?.trim() || null
  return request.headers.get('x-real-ip')?.trim() || null
}

type ActivityInput = {
  actorId: string | null
  action: string
  reason?: string | null
  metadata?: Record<string, unknown>
  request?: Request | null
}

export async function recordActivity(input: ActivityInput): Promise<void> {
  if (!process.env.DATABASE_URL) return
  try {
    const metadata: Prisma.InputJsonValue = {
      ...(input.metadata ?? {}),
      ip: ipFrom(input.request ?? null),
      method: input.request?.method ?? null,
      path: input.request ? new URL(input.request.url).pathname : null,
      userAgent: input.request?.headers.get('user-agent')?.slice(0, 160) ?? null,
    }
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId,
        action: input.action,
        reason: input.reason ? input.reason.slice(0, 500) : null,
        metadata,
      },
    })
  } catch (error) {
    console.warn('[pft activity] write failed', error)
  }
}

export type ActivityEntry = {
  id: string
  action: string
  reason: string | null
  createdAt: string
  actor: { id: string | null; name: string | null; email: string | null; role: string | null }
  ip: string | null
  path: string | null
  method: string | null
  userAgent: string | null
  metadataExcerpt: string | null
}

type ListInput = {
  scope: ActivityScope
  query?: string
  take?: number
  cursor?: string | null
}

function metadataString(metadata: unknown, key: string) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const value = (metadata as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
}

/** Safe, non-secret excerpt of the event metadata for the log table. */
function metadataExcerpt(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const skip = new Set(['ip', 'path', 'method', 'userAgent', 'deviceHash'])
  const parts = Object.entries(metadata as Record<string, unknown>)
    .filter(([key, value]) => !skip.has(key) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'))
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${String(value).slice(0, 60)}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

export async function listActivity({ scope, query, take = 50, cursor }: ListInput): Promise<{ items: ActivityEntry[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(take, 1), 200)
  const filters: Prisma.AuditLogWhereInput[] = []

  if (scope === 'trader') {
    // Trader-authored events plus anything touching a trader account.
    filters.push({ OR: [{ action: { startsWith: 'TRADER_' } }, { actor: { role: 'TRADER' } }] })
  } else {
    // Staff-authored operations, including the audit rows written by admin routes.
    filters.push({ actor: { role: { in: [...STAFF_ROLES] } } })
  }

  if (query?.trim()) {
    const needle = query.trim()
    filters.push({
      OR: [
        { action: { contains: needle, mode: 'insensitive' } },
        { reason: { contains: needle, mode: 'insensitive' } },
        { actor: { email: { contains: needle, mode: 'insensitive' } } },
        { actor: { name: { contains: needle, mode: 'insensitive' } } },
      ],
    })
  }

  if (cursor) filters.push({ createdAt: { lt: new Date(cursor) } })

  const rows = await prisma.auditLog.findMany({
    where: { AND: filters },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    select: {
      id: true,
      action: true,
      reason: true,
      metadata: true,
      createdAt: true,
      actor: { select: { id: true, name: true, email: true, role: true } },
    },
  })

  const page = rows.slice(0, limit)
  const next = rows.length > limit ? page[page.length - 1]?.createdAt.toISOString() ?? null : null

  return {
    items: page.map((row) => ({
      id: row.id,
      action: row.action,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
      actor: {
        id: row.actor?.id ?? null,
        name: row.actor?.name ?? null,
        email: row.actor?.email ?? null,
        role: row.actor?.role ?? null,
      },
      ip: metadataString(row.metadata, 'ip'),
      path: metadataString(row.metadata, 'path'),
      method: metadataString(row.metadata, 'method'),
      userAgent: metadataString(row.metadata, 'userAgent'),
      metadataExcerpt: metadataExcerpt(row.metadata),
    })),
    nextCursor: next,
  }
}
