import test, { after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { beginTestPrismaInjection, endTestPrismaInjection } from './test-prisma-injection'

/**
 * DB-free tests for the staff push pipeline (lib/support/push.ts).
 *
 * Contract under test:
 * - notifySupport is a no-op when web-push is not configured (no env);
 * - payloads contain ONLY the review-safe event (publicId, kind, subject) —
 *   never a message body;
 * - all registered SUPPORT subscriptions receive the notification;
 * - a 410/410(Gone/NotFound) endpoint is removed from the store;
 * - push failures never propagate (best-effort by contract).
 *
 * `web-push` and the prisma singleton are module-mocked, so no network and no
 * database are touched. Requires Node >= 22.3 with --experimental-test-module-mocks.
 */

const [NODE_MAJOR = 0, NODE_MINOR = 0] = process.versions.node.split('.').map(Number)
const CAN_RUN = NODE_MAJOR > 22 || (NODE_MAJOR === 22 && NODE_MINOR >= 3)
const SKIP = CAN_RUN ? false : 'requires Node >= 22.3 for module mocks'

const CLEAN_ENV = { ...process.env }
for (const key of ['SUPPORT_PUSH_VAPID_PUBLIC_KEY', 'SUPPORT_PUSH_VAPID_PRIVATE_KEY', 'SUPPORT_PUSH_CONTACT']) {
  delete process.env[key]
}

test('notifySupport is a no-op without VAPID configuration', { skip: SKIP }, async () => {
  const { notifySupport } = await import('../lib/support/push')
  beginTestPrismaInjection({ pushSubscription: { findMany: async () => [] } } as never)
  try {
    // Must resolve without touching prisma (findMany would throw if reached).
    await assert.doesNotReject(() => notifySupport({ publicId: 'SUP-TEST', kind: 'ticket.created' }))
  } finally {
    endTestPrismaInjection()
  }
})

test('notifySupport sends review-safe payloads and drops gone endpoints', { skip: SKIP }, async () => {
  process.env.SUPPORT_PUSH_VAPID_PUBLIC_KEY = 'BTestPublicKey'
  process.env.SUPPORT_PUSH_VAPID_PRIVATE_KEY = 'TestPrivateKey'
  process.env.SUPPORT_PUSH_CONTACT = 'support@example.com'

  const sentPayloads: string[] = []
  const sentEndpoints: string[] = []
  const removedEndpoints: string[] = []

  mock.module('web-push', {
    defaultExport: {
      sendNotification: async (_sub: unknown, payload: Buffer) => {
        sentPayloads.push(payload.toString())
        const endpoint = (_sub as { endpoint: string }).endpoint
        sentEndpoints.push(endpoint)
        if (endpoint === 'https://push.example/gone') {
          const err = new Error('gone') as Error & { statusCode: number }
          err.statusCode = 410
          throw err
        }
      },
    },
  })

  beginTestPrismaInjection({
    pushSubscription: {
      findMany: async () => [
        { endpoint: 'https://push.example/ok', p256dh: 'k1', auth: 'a1' },
        { endpoint: 'https://push.example/gone', p256dh: 'k2', auth: 'a2' },
      ],
      deleteMany: async (args: { where: { endpoint: string } }) => {
        removedEndpoints.push(args.where.endpoint)
        return { count: 1 }
      },
    },
  } as never)

  try {
    const { notifySupport } = await import('../lib/support/push')
    await notifySupport({ publicId: 'SUP-AB12CD34EF', kind: 'message.from_trader' })

    assert.equal(sentEndpoints.length, 2, 'every subscription is attempted')
    assert.deepEqual(removedEndpoints, ['https://push.example/gone'])

    for (const payload of sentPayloads) {
      const parsed = JSON.parse(payload) as Record<string, unknown>
      assert.deepEqual(
        Object.keys(parsed).sort(),
        ['kind', 'publicId'],
        'payload must carry only the reference and kind, never a body',
      )
    }
  } finally {
    endTestPrismaInjection()
    mock.restoreAll()
    for (const key of ['SUPPORT_PUSH_VAPID_PUBLIC_KEY', 'SUPPORT_PUSH_VAPID_PRIVATE_KEY', 'SUPPORT_PUSH_CONTACT']) {
      delete process.env[key]
    }
  }
})

test('notifySupport swallows send failures', { skip: SKIP }, async () => {
  process.env.SUPPORT_PUSH_VAPID_PUBLIC_KEY = 'BTestPublicKey'
  process.env.SUPPORT_PUSH_VAPID_PRIVATE_KEY = 'TestPrivateKey'
  process.env.SUPPORT_PUSH_CONTACT = 'support@example.com'

  mock.module('web-push', {
    defaultExport: {
      sendNotification: async () => {
        const err = new Error('network down') as Error & { statusCode: number }
        err.statusCode = 503
        throw err
      },
    },
  })

  beginTestPrismaInjection({
    pushSubscription: {
      findMany: async () => [{ endpoint: 'https://push.example/ok', p256dh: 'k', auth: 'a' }],
      deleteMany: async () => ({ count: 0 }),
    },
  } as never)

  try {
    const { notifySupport } = await import('../lib/support/push')
    // A 5xx neither removes the subscription nor rejects.
    await assert.doesNotReject(() => notifySupport({ publicId: 'SUP-X1', kind: 'ticket.created' }))
  } finally {
    endTestPrismaInjection()
    mock.restoreAll()
    process.env = CLEAN_ENV
  }
})

after(() => {
  for (const key of ['SUPPORT_PUSH_VAPID_PUBLIC_KEY', 'SUPPORT_PUSH_VAPID_PRIVATE_KEY', 'SUPPORT_PUSH_CONTACT']) {
    delete process.env[key]
  }
})
