import { randomBytes } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import type { CertificateType } from './types'

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // unambiguous, no 0/O/1/I

function newPublicId(): string {
  const bytes = randomBytes(8)
  let suffix = ''
  for (let i = 0; i < 10; i += 1) suffix += ALPHABET[bytes[i] % ALPHABET.length]
  return `PFT-${suffix}`
}

type EventInput = {
  type: CertificateType
  eventKey: string
  accountId?: string
  payoutId?: string
}

/**
 * Idempotently issues certificates for a trader's confirmed achievements.
 * Achievements are read from the authoritative records (account status for
 * phase/funded, `DISBURSED` payouts) so a repeated call never duplicates.
 */
export async function ensureCertificatesForUser(userId: string): Promise<number> {
  const [accounts, payouts] = await Promise.all([
    prisma.tradingAccount.findMany({
      where: { userId, status: { in: ['PASSED_PHASE_1', 'PASSED_PHASE_2', 'FUNDED'] } },
      select: { id: true, status: true },
    }),
    prisma.payout.findMany({
      where: { userId, status: 'DISBURSED' },
      select: { id: true, accountId: true },
    }),
  ])

  const events: EventInput[] = []
  for (const account of accounts) {
    const type: CertificateType =
      account.status === 'PASSED_PHASE_1' ? 'PHASE_1' : account.status === 'PASSED_PHASE_2' ? 'PHASE_2' : 'FUNDED'
    events.push({ type, eventKey: account.id, accountId: account.id })
  }
  for (const payout of payouts) {
    events.push({ type: 'PAYOUT', eventKey: payout.id, payoutId: payout.id, accountId: payout.accountId })
  }

  let issued = 0
  for (const event of events) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await prisma.certificate.upsert({
          where: { userId_type_eventKey: { userId, type: event.type, eventKey: event.eventKey } },
          create: {
            publicId: newPublicId(),
            userId,
            type: event.type,
            eventKey: event.eventKey,
            accountId: event.accountId ?? null,
            payoutId: event.payoutId ?? null,
          },
          update: {}, // already exists — keep the original issue record untouched
        })
        issued += 1
        break
      } catch {
        // Public-id collision only: retry with a fresh random id.
      }
    }
  }
  return issued
}

export async function revokeCertificate(publicId: string, actorId: string, reason: string) {
  const updated = await prisma.certificate.updateMany({
    where: { publicId, status: 'VERIFIED' },
    data: { status: 'REVOKED', revokedAt: new Date(), revokeReason: reason.slice(0, 500), revokedById: actorId },
  })
  return updated.count > 0
}
