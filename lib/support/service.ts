import { Prisma, type SupportCategory, type SupportPriority, type SupportStatus } from '@prisma/client'
import { createHash, randomBytes } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { recordActivity } from '@/lib/admin/activity'
import {
  canTransition,
  cleanText,
  SUPPORT_LIMITS,
  ValidationError,
  type Paginated,
  type StaffTicketMessage,
  type TicketMessage,
  type TicketSummary,
} from './types'

const PUBLIC_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * Idempotency keys are namespaced by sender so a trader and a staff member can
 * never collide on the same ticket, and a retry can only ever return the
 * caller's own message.
 */
function scopedIdempotencyKey(senderType: 'TRADER' | 'STAFF', actorId: string, key: string | null) {
  return key ? `${senderType}:${actorId}:${key}` : null
}

function newPublicId() {
  const bytes = randomBytes(10)
  let suffix = ''
  for (let index = 0; index < 10; index += 1) suffix += PUBLIC_ID_ALPHABET[bytes[index]! % PUBLIC_ID_ALPHABET.length]
  return `SUP-${suffix}`
}

/**
 * Deterministic ticket reference for a keyed creation request. Two concurrent
 * requests that carry the same idempotency key derive the same `publicId`, so
 * the unique index lets exactly one insert win and the other is resolved by
 * reading the winner back. The key is a random client UUID, so the reference
 * stays unguessable.
 */
function publicIdForKey(userId: string, key: string) {
  const digest = createHash('sha256').update(`support-handoff:${userId}:${key}`).digest()
  let suffix = ''
  for (let index = 0; index < 10; index += 1) suffix += PUBLIC_ID_ALPHABET[digest[index]! % PUBLIC_ID_ALPHABET.length]
  return `SUP-${suffix}`
}

const SUMMARY_SELECT = {
  publicId: true,
  subject: true,
  category: true,
  status: true,
  priority: true,
  createdAt: true,
  updatedAt: true,
  resolvedAt: true,
  closedAt: true,
  _count: { select: { messages: true } },
} as const

type SummaryRow = {
  publicId: string
  subject: string
  category: SupportCategory
  status: SupportStatus
  priority: SupportPriority
  createdAt: Date
  updatedAt: Date
  resolvedAt: Date | null
  closedAt: Date | null
  _count: { messages: number }
}

function toSummary(row: SummaryRow): TicketSummary {
  return {
    publicId: row.publicId,
    subject: row.subject,
    category: row.category,
    status: row.status,
    priority: row.priority,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    messageCount: row._count.messages,
  }
}

type TicketScope = { id: string; publicId: string; userId: string; status: SupportStatus }

/**
 * Resolves a ticket by its public reference (preferred) or internal id.
 * Ownership is never inferred from the input — callers must still compare userId.
 */
async function resolveTicket(ref: string) {
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(ref)) return null
  return prisma.supportTicket.findFirst({
    where: { OR: [{ publicId: ref }, { id: ref }] },
    select: { id: true, publicId: true, userId: true, status: true, subject: true, assignedToId: true },
  })
}

/* -------------------------------------------------------------------------- */
/* Trader                                                                      */
/* -------------------------------------------------------------------------- */

export async function createTicket(input: {
  userId: string
  subject: string
  category: SupportCategory
  body: string
  request: Request
  /** Optional client key; stored on the first message so a retried request cannot duplicate it. */
  idempotencyKey?: string | null
}) {
  const subject = cleanText(input.subject, {
    min: SUPPORT_LIMITS.subjectMin,
    max: SUPPORT_LIMITS.subjectMax,
    field: 'Subject',
  })
  const body = cleanText(input.body, {
    min: SUPPORT_LIMITS.bodyMin,
    max: SUPPORT_LIMITS.bodyMax,
    field: 'Message',
  })

  // Status, priority and assignee are decided by the server only.
  const keyedId = input.idempotencyKey ? publicIdForKey(input.userId, input.idempotencyKey) : null
  let deterministicId = keyedId

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const ticket = await prisma.supportTicket.create({
        data: {
          publicId: deterministicId ?? newPublicId(),
          userId: input.userId,
          subject,
          category: input.category,
          status: 'OPEN',
          priority: 'NORMAL',
          messages: {
            create: {
              senderType: 'TRADER',
              senderUserId: input.userId,
              body,
              idempotencyKey: scopedIdempotencyKey('TRADER', input.userId, input.idempotencyKey ?? null),
            },
          },
        },
        select: SUMMARY_SELECT,
      })

      void recordActivity({
        actorId: input.userId,
        action: 'TRADER_SUPPORT_TICKET_CREATED',
        request: input.request,
        metadata: { publicId: ticket.publicId, category: ticket.category },
      })

      return { ...toSummary(ticket), reused: false as const }
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        if (deterministicId) {
          // A retry (or a concurrent duplicate) already created this ticket.
          const existing = await prisma.supportTicket.findFirst({
            where: { publicId: deterministicId, userId: input.userId, status: { not: 'CLOSED' } },
            select: SUMMARY_SELECT,
          })
          if (existing) return { ...toSummary(existing), reused: true as const }
          // Reference taken by another user or the ticket was closed: use a random id.
          deterministicId = null
          continue
        }
        // Random reference collision only.
        if (attempt < 3) continue
      }
      throw error
    }
  }
  throw new Error('Unable to allocate a ticket reference')
}

export async function listTraderTickets(userId: string, options: {
  page: number
  pageSize: number
  status?: SupportStatus
}): Promise<Paginated<TicketSummary>> {
  const where: Prisma.SupportTicketWhereInput = { userId, ...(options.status ? { status: options.status } : {}) }
  const [rows, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      select: SUMMARY_SELECT,
      orderBy: { updatedAt: 'desc' },
      skip: (options.page - 1) * options.pageSize,
      take: options.pageSize,
    }),
    prisma.supportTicket.count({ where }),
  ])
  return { items: rows.map(toSummary), page: options.page, pageSize: options.pageSize, total }
}

/** Returns null for both "missing" and "someone else's ticket" so IDs cannot be probed. */
export async function getTraderTicket(userId: string, ref: string, pagination: { page: number; pageSize: number }) {
  const found = await resolveTicket(ref)
  if (!found || found.userId !== userId) return null

  // A ticket can be deleted between the lookup and this read; treat that as 404, not 500.
  const ticket = await prisma.supportTicket.findUnique({ where: { id: found.id }, select: SUMMARY_SELECT })
  if (!ticket) return null
  const [messages, total] = await Promise.all([
    prisma.supportMessage.findMany({
      where: { ticketId: found.id },
      orderBy: { createdAt: 'asc' },
      skip: (pagination.page - 1) * pagination.pageSize,
      take: pagination.pageSize,
      select: { id: true, senderType: true, body: true, createdAt: true },
    }),
    prisma.supportMessage.count({ where: { ticketId: found.id } }),
  ])
  const items: TicketMessage[] = messages.map((message) => ({
    id: message.id,
    // Staff identity is not exposed to traders; they see the support desk.
    senderType: message.senderType,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
  }))
  return {
    ticket: toSummary(ticket),
    messages: { items, page: pagination.page, pageSize: pagination.pageSize, total },
  }
}

export async function addTraderMessage(input: {
  userId: string
  ref: string
  body: string
  idempotencyKey: string | null
  request: Request
}) {
  const found = await resolveTicket(input.ref)
  if (!found || found.userId !== input.userId) return { error: 'Ticket not found.' as const, status: 404 }
  if (found.status === 'CLOSED') {
    return { error: 'This ticket is closed. Open a new ticket for further help.' as const, status: 409 }
  }

  const body = cleanText(input.body, {
    min: SUPPORT_LIMITS.bodyMin,
    max: SUPPORT_LIMITS.bodyMax,
    field: 'Message',
  })

  const storedKey = scopedIdempotencyKey('TRADER', input.userId, input.idempotencyKey)

  // Fast path for retries: return the stored message instead of attempting a duplicate insert.
  if (storedKey) {
    const existing = await prisma.supportMessage.findFirst({
      where: { ticketId: found.id, idempotencyKey: storedKey },
      select: { id: true, senderType: true, body: true, createdAt: true },
    })
    if (existing) {
      return {
        ok: true as const,
        message: {
          id: existing.id,
          senderType: existing.senderType,
          body: existing.body,
          createdAt: existing.createdAt.toISOString(),
        } satisfies TicketMessage,
        duplicate: true,
      }
    }
  }

  const reopened = found.status === 'RESOLVED' || found.status === 'WAITING_FOR_USER'

  try {
    const message = await prisma.$transaction(async (tx) => {
      const created = await tx.supportMessage.create({
        data: {
          ticketId: found.id,
          senderType: 'TRADER',
          senderUserId: input.userId,
          body,
          idempotencyKey: storedKey,
        },
        select: { id: true, senderType: true, body: true, createdAt: true },
      })
      await tx.supportTicket.update({
        where: { id: found.id },
        data: {
          updatedAt: new Date(),
          ...(reopened ? { status: 'WAITING_FOR_STAFF', resolvedAt: null } : {}),
        },
      })
      return created
    })

    void recordActivity({
      actorId: input.userId,
      action: 'TRADER_SUPPORT_MESSAGE_SENT',
      request: input.request,
      metadata: { publicId: found.publicId, length: body.length },
    })

    return {
      ok: true as const,
      message: {
        id: message.id,
        senderType: message.senderType,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
      } satisfies TicketMessage,
      duplicate: false,
    }
  } catch (error) {
    // Retried request with the same idempotency key: return the original message.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && storedKey) {
      const existing = await prisma.supportMessage.findFirst({
        where: { ticketId: found.id, idempotencyKey: storedKey },
        select: { id: true, senderType: true, body: true, createdAt: true },
      })
      if (existing) {
        return {
          ok: true as const,
          message: {
            id: existing.id,
            senderType: existing.senderType,
            body: existing.body,
            createdAt: existing.createdAt.toISOString(),
          } satisfies TicketMessage,
          duplicate: true,
        }
      }
    }
    throw error
  }
}

/* -------------------------------------------------------------------------- */
/* Staff                                                                       */
/* -------------------------------------------------------------------------- */

export async function listStaffTickets(options: {
  page: number
  pageSize: number
  status?: SupportStatus
  priority?: SupportPriority
  category?: SupportCategory
  assignedToId?: string | null
  sort: 'updated' | 'priority'
}): Promise<Paginated<TicketSummary & {
  trader: { name: string; email: string }
  assignedTo: { id: string; name: string; email: string } | null
}>> {
  const where: Prisma.SupportTicketWhereInput = {
    ...(options.status ? { status: options.status } : {}),
    ...(options.priority ? { priority: options.priority } : {}),
    ...(options.category ? { category: options.category } : {}),
    ...(options.assignedToId === null
      ? { assignedToId: null }
      : options.assignedToId
        ? { assignedToId: options.assignedToId }
        : {}),
  }

  const orderBy: Prisma.SupportTicketOrderByWithRelationInput[] =
    options.sort === 'priority'
      ? [{ priority: 'desc' }, { updatedAt: 'desc' }]
      : [{ updatedAt: 'desc' }]

  const [rows, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      orderBy,
      skip: (options.page - 1) * options.pageSize,
      take: options.pageSize,
      select: {
        ...SUMMARY_SELECT,
        // Only what support needs; no phone, DOB or KYC documents.
        user: { select: { name: true, email: true } },
        assignedTo: { select: { id: true, name: true, email: true } },
      },
    }),
    prisma.supportTicket.count({ where }),
  ])

  return {
    items: rows.map((row) => ({
      ...toSummary(row),
      trader: row.user,
      assignedTo: row.assignedTo ?? null,
    })),
    page: options.page,
    pageSize: options.pageSize,
    total,
  }
}

export async function getStaffTicket(ref: string, pagination: { page: number; pageSize: number }) {
  const found = await resolveTicket(ref)
  if (!found) return null

  const ticket = await prisma.supportTicket.findUnique({
    where: { id: found.id },
    select: {
      ...SUMMARY_SELECT,
      user: { select: { name: true, email: true, kycStatus: true } },
      assignedTo: { select: { id: true, name: true, email: true } },
    },
  })
  if (!ticket) return null
  const [messages, total] = await Promise.all([
    prisma.supportMessage.findMany({
      where: { ticketId: found.id },
      orderBy: { createdAt: 'asc' },
      skip: (pagination.page - 1) * pagination.pageSize,
      take: pagination.pageSize,
      select: {
        id: true,
        senderType: true,
        body: true,
        createdAt: true,
        senderUser: { select: { name: true, email: true } },
      },
    }),
    prisma.supportMessage.count({ where: { ticketId: found.id } }),
  ])

  const items: StaffTicketMessage[] = messages.map((message) => ({
    id: message.id,
    senderType: message.senderType,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
    senderName: message.senderUser?.name ?? null,
    senderEmail: message.senderUser?.email ?? null,
  }))

  return {
    ticket: {
      ...toSummary(ticket),
      trader: { name: ticket.user.name, email: ticket.user.email, kycStatus: ticket.user.kycStatus },
      assignedTo: ticket.assignedTo ?? null,
    },
    messages: { items, page: pagination.page, pageSize: pagination.pageSize, total },
  }
}

export async function addStaffMessage(input: {
  actorId: string
  ref: string
  body: string
  idempotencyKey: string | null
  request: Request
}) {
  const found = await resolveTicket(input.ref)
  if (!found) return { error: 'Ticket not found.' as const, status: 404 }
  if (found.status === 'CLOSED') {
    return { error: 'This ticket is closed. Reopen it before replying.' as const, status: 409 }
  }

  const body = cleanText(input.body, {
    min: SUPPORT_LIMITS.bodyMin,
    max: SUPPORT_LIMITS.bodyMax,
    field: 'Message',
  })

  const storedKey = scopedIdempotencyKey('STAFF', input.actorId, input.idempotencyKey)

  // Retry fast path (see trader endpoint); the unique index still guards races.
  if (storedKey) {
    const existing = await prisma.supportMessage.findFirst({
      where: { ticketId: found.id, idempotencyKey: storedKey },
      select: { id: true, senderType: true, body: true, createdAt: true },
    })
    if (existing) {
      return {
        ok: true as const,
        message: {
          id: existing.id,
          senderType: existing.senderType,
          body: existing.body,
          createdAt: existing.createdAt.toISOString(),
        } satisfies TicketMessage,
        duplicate: true,
      }
    }
  }

  const isActive = found.status === 'OPEN' || found.status === 'IN_PROGRESS' || found.status === 'WAITING_FOR_STAFF'
  // A staff reply on a resolved ticket reopens it for follow-up (documented contract).
  const replyStatus = isActive
    ? { status: 'WAITING_FOR_USER' as const }
    : found.status === 'RESOLVED'
      ? { status: 'IN_PROGRESS' as const, resolvedAt: null }
      : {}

  try {
    const message = await prisma.$transaction(async (tx) => {
      const created = await tx.supportMessage.create({
        data: {
          ticketId: found.id,
          senderType: 'STAFF',
          senderUserId: input.actorId,
          body,
          idempotencyKey: storedKey,
        },
        select: { id: true, senderType: true, body: true, createdAt: true },
      })
      await tx.supportTicket.update({
        where: { id: found.id },
        data: {
          updatedAt: new Date(),
          ...replyStatus,
        },
      })
      return created
    })

    void recordActivity({
      actorId: input.actorId,
      action: 'SUPPORT_TICKET_REPLIED',
      request: input.request,
      metadata: { publicId: found.publicId, length: body.length },
    })

    return {
      ok: true as const,
      message: {
        id: message.id,
        senderType: message.senderType,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
      } satisfies TicketMessage,
      duplicate: false,
    }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && storedKey) {
      const existing = await prisma.supportMessage.findFirst({
        where: { ticketId: found.id, idempotencyKey: storedKey },
        select: { id: true, senderType: true, body: true, createdAt: true },
      })
      if (existing) {
        return {
          ok: true as const,
          message: {
            id: existing.id,
            senderType: existing.senderType,
            body: existing.body,
            createdAt: existing.createdAt.toISOString(),
          } satisfies TicketMessage,
          duplicate: true,
        }
      }
    }
    throw error
  }
}

export async function updateStaffTicket(input: {
  actorId: string
  actorRole: 'ADMIN' | 'RISK_MANAGER' | 'SUPPORT'
  ref: string
  status?: SupportStatus
  priority?: SupportPriority
  assign?: { assignedToId: string | null }
  request: Request
}) {
  const found = await resolveTicket(input.ref)
  if (!found) return { error: 'Ticket not found.' as const, status: 404 }

  const data: Prisma.SupportTicketUncheckedUpdateManyInput = {}
  const audit: { action: string; metadata: Record<string, unknown> }[] = []

  if (input.status) {
    if (!canTransition(found.status, input.status)) {
      return {
        error: `Invalid status transition: ${found.status} → ${input.status}.` as const,
        status: 409,
      }
    }
    if (input.status !== found.status) {
      data.status = input.status
      if (input.status === 'RESOLVED') data.resolvedAt = new Date()
      if (input.status === 'CLOSED') {
        data.closedAt = new Date()
      }
      if (input.status === 'IN_PROGRESS') data.closedAt = null
      audit.push({
        action: 'SUPPORT_TICKET_STATUS_CHANGED',
        metadata: { publicId: found.publicId, from: found.status, to: input.status },
      })
    }
  }

  if (input.priority) {
    data.priority = input.priority
    audit.push({
      action: 'SUPPORT_TICKET_PRIORITY_CHANGED',
      metadata: { publicId: found.publicId, to: input.priority },
    })
  }

  if (input.assign) {
    const target = input.assign.assignedToId
    if (target) {
      const staff = await prisma.user.findUnique({ where: { id: target }, select: { id: true, role: true } })
      if (!staff || staff.role === 'TRADER') {
        return { error: 'Assignee must be a staff member.' as const, status: 400 }
      }
      // SUPPORT can only take tickets itself; ADMIN can assign anyone.
      if (input.actorRole !== 'ADMIN' && staff.id !== input.actorId) {
        return { error: 'Support staff can only assign tickets to themselves.' as const, status: 403 }
      }
    }
    data.assignedToId = target
    audit.push({
      action: 'SUPPORT_TICKET_ASSIGNED',
      metadata: { publicId: found.publicId, assignedToId: target },
    })
  }

  if (Object.keys(data).length === 0) {
    return { error: 'No supported fields were submitted.' as const, status: 400 }
  }

  data.updatedAt = new Date()

  // Optimistic concurrency: only apply when the status is still the one we read.
  // Two admins acting at the same time can therefore never apply conflicting
  // transitions; the loser gets a 409 and retries against fresh state.
  const applied = await prisma.supportTicket.updateMany({
    where: { id: found.id, status: found.status },
    data,
  })
  if (applied.count === 0) {
    return { error: 'Ticket changed while you were editing it. Refresh and retry.' as const, status: 409 }
  }

  const updated = await prisma.supportTicket.findUnique({ where: { id: found.id }, select: SUMMARY_SELECT })
  if (!updated) {
    // Deleted between the guarded update and this read.
    return { error: 'Ticket not found.' as const, status: 404 }
  }
  for (const entry of audit) {
    void recordActivity({
      actorId: input.actorId,
      action: entry.action,
      request: input.request,
      metadata: entry.metadata,
    })
  }

  return { ok: true as const, ticket: toSummary(updated) }
}

export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError
}

export { ValidationError }


