/**
 * PHASE 1.95: isolated child process for Proxy runtime smoke.
 *
 * Each invocation imports `lib/prisma` in a fresh process with a controlled NODE_ENV.
 * Only properties are accessed — no Prisma method that could issue SQL is ever called.
 * The parent test parses the JSON printed on stdout.
 */

type Sentinel = { user: { findMany: () => Promise<string> }; marker: string }

const mode = process.argv[2]
const globalForPrisma = globalThis as unknown as { pftProductionPrisma?: unknown }

async function main(): Promise<void> {
  const result: Record<string, unknown> = { mode }

  if (mode === 'lazy') {
    result.globalBeforeImport = globalForPrisma.pftProductionPrisma !== undefined
    const { prisma, prismaLogLevels } = await import('../lib/prisma')
    result.globalAfterImport = globalForPrisma.pftProductionPrisma !== undefined
    // Property access only: no query is executed.
    result.transactionType = typeof (prisma as unknown as { $transaction: unknown }).$transaction
    result.userDelegateType = typeof (prisma as unknown as { user: unknown }).user
    result.globalAfterAccess = globalForPrisma.pftProductionPrisma !== undefined
    result.logLevelsDevelopment = prismaLogLevels('development')
    result.logLevelsProduction = prismaLogLevels('production')
    result.logLevelsTest = prismaLogLevels('test')
  } else if (mode === 'hmr') {
    const sentinel: Sentinel = {
      user: { findMany: async () => 'HMR_SENTINEL' },
      marker: 'HMR_SENTINEL',
    }
    globalForPrisma.pftProductionPrisma = sentinel
    const { prisma } = await import('../lib/prisma')
    result.value = await (prisma as unknown as Sentinel).user.findMany()
    result.sameGlobalObject = globalForPrisma.pftProductionPrisma === sentinel
  } else if (mode === 'production') {
    const sentinel: Sentinel = {
      user: { findMany: async () => 'GLOBAL_SENTINEL' },
      marker: 'GLOBAL_SENTINEL',
    }
    globalForPrisma.pftProductionPrisma = sentinel
    const { prisma } = await import('../lib/prisma')
    const delegate = (prisma as unknown as { user: unknown }).user
    result.delegateIsObject = typeof delegate === 'object' && delegate !== null
    result.usesModuleInstance = delegate !== sentinel.user
    result.globalSentinelPreserved = globalForPrisma.pftProductionPrisma === sentinel
  } else {
    throw new Error(`unknown mode: ${String(mode)}`)
  }

  console.log(JSON.stringify(result))
}

main().catch((error) => {
  console.error(JSON.stringify({ mode, error: String((error as Error)?.message ?? error) }))
  process.exit(1)
})
