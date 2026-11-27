import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { mock } from 'node:test'

type MockExports = Record<string, unknown>

/** Test files live in `scripts/`, and every test script runs from the repo root. */
const SCRIPTS_DIR = path.resolve(process.cwd(), 'scripts')

/**
 * `mock.module` compatibility shim.
 *
 * Two problems it solves:
 * 1. Node 22.14+ replaced the `exports` option with `namedExports`; on newer runtimes an
 *    `exports`-only mock silently becomes an EMPTY module, so the code under test sees
 *    `undefined` instead of the fake and every assertion fails for the wrong reason.
 *    Passing both keys keeps one test file working on either release line.
 * 2. `mock.module` resolves a relative specifier against the module that CALLS it, which
 *    is this file. Resolving against `scripts/` keeps `'../lib/prisma'` meaning the same
 *    thing it means in the test file.
 */
export function mockModule(
  specifier: string,
  options: { exports?: MockExports; defaultExport?: unknown },
) {
  const target = specifier.startsWith('.')
    ? pathToFileURL(path.resolve(SCRIPTS_DIR, specifier)).href
    : specifier
  const namedExports = options.exports ?? {}
  return mock.module(target, { ...options, namedExports } as never)
}
