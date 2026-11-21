/**
 * PHASE 1.94: shared exact-scope cleanup lifecycle for DB integration suites.
 *
 * Call from a test's `finally` block:
 *
 *   } finally {
 *     await cleanupThenDisconnect({
 *       label: 'market-candles-heartbeat',
 *       cleanup: () => cleanup(client),
 *       residual: () => client.systemComponent.count({ where: { key: KEY } }),
 *       disconnect: () => client.$disconnect(),
 *     })
 *   }
 *
 * Guarantees:
 *   - cleanup runs after a setup/assertion failure, not only on success;
 *   - cleanup targets only the caller's exact identifier (no broad deletes here);
 *   - a non-zero residual count is a visible failure;
 *   - the Prisma client/pool is always closed, even when cleanup fails;
 *   - cleanup failures are logged and re-thrown, never swallowed.
 */
export type CleanupLifecycleOptions = {
  /** Suite/test label used in diagnostics only (never contains secrets). */
  label: string
  /** Deletes only the rows created by this run. */
  cleanup: () => Promise<void>
  /** Optional residual assertion; must resolve to the remaining row count. */
  residual?: () => Promise<number>
  /** Closes the Prisma client and its pool. */
  disconnect: () => Promise<unknown>
}

function message(error: unknown): string {
  return String((error as Error)?.message ?? error)
}

export async function cleanupThenDisconnect(options: CleanupLifecycleOptions): Promise<void> {
  let failure: unknown
  try {
    await options.cleanup()
    if (options.residual) {
      const remaining = await options.residual()
      if (remaining !== 0) {
        throw new Error(`${options.label}: cleanup residual is ${remaining}, expected 0`)
      }
    }
  } catch (error) {
    failure = error
    console.error(`${options.label}: cleanup failed: ${message(error)}`)
  } finally {
    try {
      await options.disconnect()
    } catch (error) {
      console.error(`${options.label}: disconnect failed: ${message(error)}`)
      if (failure === undefined) failure = error
    }
  }
  if (failure !== undefined) throw failure
}
