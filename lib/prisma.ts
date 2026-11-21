import { PrismaClient } from '@prisma/client'

/**
 * PHASE 1.94: TEST-only Prisma injection.
 *
 * Production behaviour is unchanged: without the explicit opt-in below, every access
 * goes to the normal global PrismaClient singleton, created lazily on first use.
 *
 * Integration tests may enable `PFT_TEST_PRISMA_INJECTION=1` and install a TLS-verified
 * adapter-backed client. While enabled, every application module that imports `prisma`
 * is routed to that client; if injection is enabled but no client was installed, access
 * fails closed instead of silently using the production/DATABASE_URL client.
 */

const INJECTION_ENV = 'PFT_TEST_PRISMA_INJECTION'

const globalForPrisma = globalThis as unknown as {
  pftProductionPrisma?: PrismaClient
  pftTestPrisma?: PrismaClient
}

let moduleProductionPrisma: PrismaClient | undefined

/**
 * True when the TEST-only Prisma injection is requested (the client itself is
 * checked separately). Exported so every module that asks "is a database client
 * reachable?" shares ONE definition of the opt-in.
 */
export function testPrismaInjectionRequested(env: Record<string, string | undefined> = process.env): boolean {
  return env[INJECTION_ENV] === '1'
}

function injectionRequested(): boolean {
  return testPrismaInjectionRequested()
}

/** PHASE 1.95: the exact production log levels, exported so runtime smoke can assert them. */
export function prismaLogLevels(nodeEnv: string | undefined = process.env.NODE_ENV): Array<'error' | 'warn'> {
  return nodeEnv === 'development' ? ['error', 'warn'] : ['error']
}

function productionClient(): PrismaClient {
  // Module-scoped singleton: identical lifecycle to the pre-injection export. In
  // development the instance is also shared through globalThis (HMR); in production it
  // stays module-local, exactly as before.
  if (!moduleProductionPrisma) {
    const shared = process.env.NODE_ENV !== 'production' ? globalForPrisma.pftProductionPrisma : undefined
    moduleProductionPrisma =
      shared ??
      new PrismaClient({
        log: prismaLogLevels(),
      })
    if (process.env.NODE_ENV !== 'production') {
      globalForPrisma.pftProductionPrisma = moduleProductionPrisma
    }
  }
  return moduleProductionPrisma
}

/** Installs a TEST client. Refuses unless the explicit injection opt-in is set. */
export function installTestPrismaClient(client: PrismaClient): void {
  if (!injectionRequested()) {
    throw new Error('TEST Prisma injection requires PFT_TEST_PRISMA_INJECTION=1')
  }
  if (!client) throw new Error('TEST Prisma injection requires a client')
  globalForPrisma.pftTestPrisma = client
}

export function clearTestPrismaClient(): void {
  globalForPrisma.pftTestPrisma = undefined
}

export function hasInstalledTestPrismaClient(): boolean {
  return globalForPrisma.pftTestPrisma != null
}

function activeClient(): PrismaClient {
  if (injectionRequested()) {
    const injected = globalForPrisma.pftTestPrisma
    if (!injected) {
      throw new Error('TEST Prisma injection is enabled but no TEST client is installed — refusing to use the production client')
    }
    return injected
  }
  return productionClient()
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const client = activeClient()
    const value = Reflect.get(client, property, client)
    return typeof value === 'function' ? value.bind(client) : value
  },
})
