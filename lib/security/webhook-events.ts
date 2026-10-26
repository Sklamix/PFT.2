import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

export function webhookEventId(provider: string, rawBody: string) {
  return `${provider}:${createHash('sha256').update(rawBody, 'utf8').digest('hex')}`
}

/**
 * Atomically reserves a signed webhook delivery. Returns false when this exact
 * payload has already been accepted. Failed processing must call release.
 */
export async function claimWebhookEvent(id: string, provider: string, eventType: string) {
  if (!process.env.DATABASE_URL) return true
  try {
    await prisma.webhookEvent.create({
      data: {
        id,
        provider,
        eventType: eventType.slice(0, 120) || 'unknown',
      },
    })
    return true
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false
    throw error
  }
}

/** Allows a provider retry when the first attempt did not reach a 2xx response. */
export async function releaseWebhookEvent(id: string) {
  if (!process.env.DATABASE_URL) return
  try {
    await prisma.webhookEvent.deleteMany({ where: { id } })
  } catch (error) {
    console.error('[pft webhook] Failed to release idempotency key', error)
  }
}
