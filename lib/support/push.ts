import { createHash } from 'node:crypto'
import { prisma } from '@/lib/prisma'

/**
 * Staff push notifications for the support PWA.
 *
 * Payloads carry only the ticket reference and an event kind — never message
 * bodies — so an intercepted notification reveals nothing about a trader.
 * Failures are swallowed: push is best-effort, the queue in the app is the
 * source of truth. `web-push` itself is imported lazily inside the sender so
 * bundling edge runtimes never loads Node-only crypto paths.
 */

export type SupportPushEventKind = 'ticket.created' | 'message.from_trader'

export type SupportPushEvent = {
  publicId: string
  kind: SupportPushEventKind
  subject?: string
}

export function isWebPushConfigured() {
  return Boolean(
    process.env.SUPPORT_PUSH_VAPID_PUBLIC_KEY &&
    process.env.SUPPORT_PUSH_VAPID_PRIVATE_KEY &&
    process.env.SUPPORT_PUSH_CONTACT,
  )
}

/** Public VAPID key for the service worker's `pushManager.subscribe`. */
export function vapidPublicKey() {
  return process.env.SUPPORT_PUSH_VAPID_PUBLIC_KEY ?? null
}

type SubscriptionRow = { endpoint: string; p256dh: string; auth: string }

async function sendToSubscriptions(
  event: SupportPushEvent,
  subscriptions: SubscriptionRow[],
): Promise<{ sent: number; removed: number }> {
  const webpush = (await import('web-push')).default
  let sent = 0
  let removed = 0

  // Per-subscription dispatch so one bad endpoint never skips the rest.
  const results = await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          Buffer.from(JSON.stringify(event)),
          {
            vapidDetails: {
              subject: `mailto:${process.env.SUPPORT_PUSH_CONTACT}`,
              publicKey: process.env.SUPPORT_PUSH_VAPID_PUBLIC_KEY!,
              privateKey: process.env.SUPPORT_PUSH_VAPID_PRIVATE_KEY!,
            },
            TTL: 60 * 60 * 24,
          },
        )
        return { endpoint: sub.endpoint, removed: false }
      } catch (reason) {
        const statusCode = (reason as { statusCode?: number } | undefined)?.statusCode
        return { endpoint: sub.endpoint, removed: statusCode === 404 || statusCode === 410 }
      }
    }),
  )

  for (const result of results) {
    if (!result.removed) {
      sent += 1
      continue
    }
    removed += 1
    await prisma.pushSubscription.deleteMany({ where: { endpoint: result.endpoint } }).catch(() => undefined)
  }
  return { sent, removed }
}

/**
 * Notifies all support workers (role SUPPORT) about a trader event. Admins are
 * not notified: the admin desk is desktop-first, the PWA is the worker's tool.
 * Never throws.
 */
export async function notifySupport(event: SupportPushEvent): Promise<void> {
  try {
    if (!isWebPushConfigured()) return
    const subscriptions = await prisma.pushSubscription.findMany({
      where: { user: { role: 'SUPPORT' } },
      select: { endpoint: true, p256dh: true, auth: true },
      take: 500,
    })
    if (subscriptions.length === 0) return
    await sendToSubscriptions(event, subscriptions)
  } catch {
    // Best-effort by contract: a push failure must never break ticket creation.
  }
}

/** Deterministic observability helper: short hash of the endpoint. */
export function fingerprint(endpoint: string) {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 12)
}
