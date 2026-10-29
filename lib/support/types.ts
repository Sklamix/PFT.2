import type { SupportCategory, SupportPriority, SupportStatus } from '@prisma/client'

/** Closed set of support categories accepted from clients. */
export const SUPPORT_CATEGORIES = [
  'GENERAL',
  'CHALLENGE',
  'PAYOUT',
  'KYC',
  'ACCOUNT',
  'TECHNICAL',
  'RULES',
] as const satisfies readonly SupportCategory[]

/** Statuses a ticket can be in. */
export const SUPPORT_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'WAITING_FOR_USER',
  'WAITING_FOR_STAFF',
  'RESOLVED',
  'CLOSED',
] as const satisfies readonly SupportStatus[]

export const SUPPORT_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const satisfies readonly SupportPriority[]

/**
 * Allowed status transitions. A same-status update is treated as a no-op and
 * accepted, so retried PATCH requests do not fail.
 */
export const STATUS_TRANSITIONS: Record<SupportStatus, readonly SupportStatus[]> = {
  OPEN: ['IN_PROGRESS', 'WAITING_FOR_USER', 'WAITING_FOR_STAFF', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['OPEN', 'WAITING_FOR_USER', 'WAITING_FOR_STAFF', 'RESOLVED', 'CLOSED'],
  WAITING_FOR_USER: ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_STAFF', 'RESOLVED', 'CLOSED'],
  WAITING_FOR_STAFF: ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_USER', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['IN_PROGRESS', 'WAITING_FOR_USER', 'WAITING_FOR_STAFF', 'CLOSED'],
  CLOSED: ['IN_PROGRESS'],
}

export const SUPPORT_LIMITS = {
  subjectMin: 4,
  subjectMax: 160,
  bodyMin: 1,
  bodyMax: 5_000,
  idempotencyKeyMin: 8,
  idempotencyKeyMax: 100,
  pageSizeDefault: 20,
  pageSizeMax: 50,
} as const

class ValidationError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export { ValidationError }

export type Pagination = { page: number; pageSize: number }

export function parsePagination(url: URL): Pagination {
  const rawPage = Number(url.searchParams.get('page') ?? 1)
  const rawSize = Number(url.searchParams.get('pageSize') ?? SUPPORT_LIMITS.pageSizeDefault)
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1
  const pageSize = Number.isFinite(rawSize) && rawSize >= 1
    ? Math.min(Math.floor(rawSize), SUPPORT_LIMITS.pageSizeMax)
    : SUPPORT_LIMITS.pageSizeDefault
  return { page, pageSize }
}

export function isSupportStatus(value: unknown): value is SupportStatus {
  return typeof value === 'string' && (SUPPORT_STATUSES as readonly string[]).includes(value)
}

export function isSupportPriority(value: unknown): value is SupportPriority {
  return typeof value === 'string' && (SUPPORT_PRIORITIES as readonly string[]).includes(value)
}

export function isSupportCategory(value: unknown): value is SupportCategory {
  return typeof value === 'string' && (SUPPORT_CATEGORIES as readonly string[]).includes(value)
}

export function canTransition(from: SupportStatus, to: SupportStatus) {
  return from === to || STATUS_TRANSITIONS[from].includes(to)
}

/** Trims, collapses whitespace and strips control characters (keeps newlines). */
export function cleanText(value: unknown, { min, max, field }: { min: number; max: number; field: string }) {
  if (typeof value !== 'string') throw new ValidationError(`${field} is required.`)
  const cleaned = value
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
  if (cleaned.length < min) throw new ValidationError(`${field} must be at least ${min} characters.`)
  if (cleaned.length > max) throw new ValidationError(`${field} must be at most ${max} characters.`)
  return cleaned
}

export function parseIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new ValidationError('idempotencyKey must be a string.')
  const key = value.trim()
  if (!/^[A-Za-z0-9:_-]{8,100}$/.test(key)) {
    throw new ValidationError('idempotencyKey must be 8-100 characters of A-Z, a-z, 0-9, :, _ or -.')
  }
  return key
}

export type TicketSummary = {
  publicId: string
  subject: string
  category: SupportCategory
  status: SupportStatus
  priority: SupportPriority
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
  closedAt: string | null
  messageCount: number
}

export type TicketMessage = {
  id: string
  senderType: 'TRADER' | 'STAFF' | 'AI'
  body: string
  createdAt: string
}

export type StaffTicketMessage = TicketMessage & {
  senderName: string | null
  senderEmail: string | null
}

export type Paginated<T> = {
  items: T[]
  page: number
  pageSize: number
  total: number
}

export type CreateTicketInput = {
  subject: string
  category: SupportCategory
  body: string
}
