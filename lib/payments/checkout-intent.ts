import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'

/**
 * Concurrent checkout deduplication (D7).
 *
 * The intent key covers the stable business dimensions only: normalized customer email
 * and the purchased product. It deliberately excludes prices, URLs and random values,
 * so a caller cannot bypass dedupe by varying them. The database enforces uniqueness.
 */

export const CHECKOUT_INTENT_TTL_MS = 30 * 60_000
const CREATING_STALE_MS = 90_000
const WAIT_STEP_MS = 250
const WAIT_STEPS = 12

export type CheckoutIntentInput = {
  email: string
  planSize: number
  evaluationType: string
  drawdownMode: string
  dailyLossType: number
  hasFrozenBackup: boolean
  resetAccountId?: string | null
  product?: 'CHALLENGE' | 'RESET'
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function checkoutIntentKey(input: CheckoutIntentInput): string {
  const material = [
    'checkout:v1',
    input.product ?? (input.resetAccountId ? 'RESET' : 'CHALLENGE'),
    normalizeEmail(input.email),
    String(input.planSize),
    input.evaluationType,
    input.drawdownMode,
    String(input.dailyLossType),
    input.hasFrozenBackup ? 'backup' : 'standard',
    input.resetAccountId ?? '',
  ].join('|')
  return createHash('sha256').update(material).digest('hex')
}

export type ClaimResult =
  | { state: 'new'; key: string }
  | { state: 'existing'; key: string; paymentUrl: string; orderId: string | null }
  | { state: 'in_progress'; key: string }

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function readIntent(prisma: PrismaClient, key: string) {
  return prisma.checkoutIntent.findUnique({ where: { key } })
}

/**
 * Claims the single active intent for this identity+product. The loser of a concurrent
 * race waits briefly for the winner to store the invoice URL, then returns it instead
 * of creating a second payable invoice.
 */
export async function claimCheckoutIntent(
  prisma: PrismaClient,
  input: {
    key: string
    email: string
    userId: string | null
    now?: Date
    /** Test seam; production uses the defaults above. */
    wait?: { stepMs: number; steps: number }
  },
): Promise<ClaimResult> {
  const now = input.now ?? new Date()
  const expiresAt = new Date(now.getTime() + CHECKOUT_INTENT_TTL_MS)
  const waitSteps = input.wait?.steps ?? WAIT_STEPS
  const waitStepMs = input.wait?.stepMs ?? WAIT_STEP_MS

  try {
    await prisma.checkoutIntent.create({
      data: {
        key: input.key,
        email: normalizeEmail(input.email),
        userId: input.userId,
        status: 'CREATING',
        expiresAt,
      },
    })
    return { state: 'new', key: input.key }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
  }

  for (let step = 0; step < waitSteps; step += 1) {
    const existing = await readIntent(prisma, input.key)
    if (!existing) break
    if (existing.status === 'READY' && existing.paymentUrl && existing.expiresAt.getTime() > now.getTime()) {
      return { state: 'existing', key: input.key, paymentUrl: existing.paymentUrl, orderId: existing.orderId }
    }
    const creatingFresh =
      existing.status === 'CREATING' && now.getTime() - existing.updatedAt.getTime() <= CREATING_STALE_MS
    if (creatingFresh) {
      if (step < waitSteps - 1) {
        await sleep(waitStepMs)
        continue
      }
      return { state: 'in_progress', key: input.key }
    }

    // Completed, failed or stale: take the intent over with an optimistic CAS. A
    // concurrent winner makes count 0 and we read its result on the next loop.
    const taken = await prisma.checkoutIntent.updateMany({
      where: { key: input.key, updatedAt: existing.updatedAt },
      data: {
        status: 'CREATING',
        orderId: null,
        paymentUrl: null,
        attempts: { increment: 1 },
        expiresAt,
        userId: input.userId,
      },
    })
    if (taken.count === 1) return { state: 'new', key: input.key }
  }
  return { state: 'in_progress', key: input.key }
}

/** Records the invoice created by the winning request. Called in the order transaction. */
export async function completeCheckoutIntentInTx(
  tx: Prisma.TransactionClient,
  input: { key: string; orderId: string; paymentUrl: string; expiresAt?: Date; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date()
  await tx.checkoutIntent.updateMany({
    where: { key: input.key },
    data: {
      status: 'READY',
      orderId: input.orderId,
      paymentUrl: input.paymentUrl,
      expiresAt: input.expiresAt ?? new Date(now.getTime() + CHECKOUT_INTENT_TTL_MS),
    },
  })
}

/** Releases a failed claim so the next request can try again without waiting. */
export async function failCheckoutIntent(prisma: PrismaClient, key: string): Promise<void> {
  await prisma.checkoutIntent.updateMany({
    where: { key, status: 'CREATING' },
    data: { status: 'FAILED' },
  }).catch((error) => {
    console.error('[pft checkout] Could not release checkout intent', error)
  })
}
