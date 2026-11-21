/**
 * PHASE 1.96a: admin store availability policy.
 *
 * Production NEVER falls back to the in-memory mock store. The mock backend is only
 * reachable in a non-production environment AND with the explicit
 * `PFT_ALLOW_ADMIN_MOCK=1` opt-in. Any uncertainty (missing DATABASE_URL, failed
 * probe, Prisma init failure, timeout) resolves to `unavailable` in production.
 */

export type AdminStoreMode = 'database' | 'mock' | 'unavailable'

export class AdminStoreUnavailableError extends Error {
  constructor(message = 'Admin store is unavailable') {
    super(message)
    this.name = 'AdminStoreUnavailableError'
  }
}

export function adminMockAllowed(env: Record<string, string | undefined> = process.env): boolean {
  if (env.NODE_ENV === 'production') return false
  return env.PFT_ALLOW_ADMIN_MOCK === '1'
}

export function decideAdminStore(input: {
  hasDatabase: boolean
  mockAllowed: boolean
  /** Undefined means "not probed yet"; anything but true means the probe failed. */
  probeOk?: boolean
}): AdminStoreMode {
  if (!input.hasDatabase) return input.mockAllowed ? 'mock' : 'unavailable'
  if (input.probeOk === false) return input.mockAllowed ? 'mock' : 'unavailable'
  return 'database'
}
