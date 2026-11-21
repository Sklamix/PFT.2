import type { PrismaClient } from '@prisma/client'
import { clearTestPrismaClient, installTestPrismaClient } from '../lib/prisma'

/**
 * PHASE 1.94: explicit TEST-only injection lifecycle for integration suites.
 * Call in `before` after creating the TLS-validated adapter client, and always call
 * `endTestPrismaInjection()` in `after` (even on failure).
 */
export function beginTestPrismaInjection(client: PrismaClient): void {
  const previous = process.env.PFT_TEST_PRISMA_INJECTION
  process.env.PFT_TEST_PRISMA_INJECTION = '1'
  try {
    installTestPrismaClient(client)
  } catch (error) {
    // Never leave the opt-in flag set when installation fails: a later access would
    // then fail closed far away from the actual cause.
    if (previous === undefined) delete process.env.PFT_TEST_PRISMA_INJECTION
    else process.env.PFT_TEST_PRISMA_INJECTION = previous
    throw error
  }
}

export function endTestPrismaInjection(): void {
  clearTestPrismaClient()
  delete process.env.PFT_TEST_PRISMA_INJECTION
}

export function testPrismaInjectionEnabled(): boolean {
  return process.env.PFT_TEST_PRISMA_INJECTION === '1'
}
