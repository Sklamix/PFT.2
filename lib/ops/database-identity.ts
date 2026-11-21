import {
  ALLOWED_TEST_DB_HOSTS,
  FORBIDDEN_TEST_DATABASE_URLS,
  REQUIRED_TEST_DB_NAME,
} from '@/scripts/observability-db-gate'

/**
 * Read-only classification of the database the runtime is actually connected to.
 *
 * It reuses the owner-approved test-database allowlist from the observability
 * gate (single source of truth) and never returns or logs the connection URL,
 * username or password. Only the hostname and database name are surfaced.
 */

export type DatabaseEnvironment = 'production' | 'preview' | 'development' | 'test' | 'unknown'
export type DatabaseIdentityStatus = 'TEST' | 'PRODUCTION' | 'BLOCKED'

export type DatabaseIdentityInput = {
  url: string | null | undefined
  env?: { VERCEL_ENV?: string | undefined; NODE_ENV?: string | undefined }
  /** Value returned by `SELECT current_database()` when a read-only query succeeded. */
  runtimeDatabaseName?: string | null
}

export type DatabaseIdentityReport = {
  status: DatabaseIdentityStatus
  environment: DatabaseEnvironment
  hostname: string | null
  databaseName: string | null
  runtimeDatabaseName: string | null
  isApprovedTestDatabase: boolean
  isProductionDatabase: boolean
  identityVerified: boolean
  reason: string | null
}

/** Production-looking database names, in addition to the forbidden host list. */
const PRODUCTION_DB_NAME = /(^|_)(prod|production)(_|$)/i

function classifyEnvironment(env: DatabaseIdentityInput['env']): DatabaseEnvironment {
  const vercel = env?.VERCEL_ENV?.trim().toLowerCase()
  if (vercel === 'production') return 'production'
  if (vercel === 'preview') return 'preview'
  if (vercel === 'development') return 'development'
  if (env?.NODE_ENV === 'test') return 'test'
  return 'unknown'
}

export function classifyDatabaseIdentity(input: DatabaseIdentityInput): DatabaseIdentityReport {
  const environment = classifyEnvironment(input.env)
  const runtimeDatabaseName = input.runtimeDatabaseName ?? null
  const base = {
    environment,
    runtimeDatabaseName,
    isApprovedTestDatabase: false,
    isProductionDatabase: false,
    identityVerified: false,
    reason: null as string | null,
  }

  const raw = input.url?.trim()
  if (!raw || !/^postgres(ql)?:\/\//i.test(raw)) {
    return { ...base, status: 'BLOCKED', hostname: null, databaseName: null, reason: 'database URL is missing or not PostgreSQL' }
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ...base, status: 'BLOCKED', hostname: null, databaseName: null, reason: 'database URL is not a valid URL' }
  }

  const hostname = parsed.hostname.toLowerCase() || null
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0]) || null

  const forbiddenHost = FORBIDDEN_TEST_DATABASE_URLS.some((pattern) => pattern.test(raw))
  const productionName = databaseName ? PRODUCTION_DB_NAME.test(databaseName) : false
  const isProductionDatabase = environment === 'production' || forbiddenHost || productionName

  const isApprovedTestDatabase =
    hostname !== null && ALLOWED_TEST_DB_HOSTS.includes(hostname) && databaseName === REQUIRED_TEST_DB_NAME

  if (isProductionDatabase) {
    const identityVerified = runtimeDatabaseName !== null && runtimeDatabaseName === databaseName
    return {
      ...base,
      status: 'PRODUCTION',
      hostname,
      databaseName,
      isProductionDatabase: true,
      identityVerified,
      reason: 'runtime is connected to a production-classified database',
    }
  }

  if (isApprovedTestDatabase) {
    if (runtimeDatabaseName === null) {
      return {
        ...base,
        status: 'BLOCKED',
        hostname,
        databaseName,
        isApprovedTestDatabase: true,
        reason: 'approved test host, but the live database identity query did not succeed',
      }
    }
    if (runtimeDatabaseName !== REQUIRED_TEST_DB_NAME) {
      return {
        ...base,
        status: 'BLOCKED',
        hostname,
        databaseName,
        isApprovedTestDatabase: true,
        reason: 'live current_database() does not match the approved test database',
      }
    }
    return {
      ...base,
      status: 'TEST',
      hostname,
      databaseName,
      isApprovedTestDatabase: true,
      identityVerified: true,
      reason: null,
    }
  }

  return {
    ...base,
    status: 'BLOCKED',
    hostname,
    databaseName,
    reason: 'database endpoint is not on the owner-approved test allowlist',
  }
}

export type ReadOnlyQueryClient = {
  $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>
}

/** Read-only identity probe. One SELECT; never writes. */
export async function readRuntimeDatabaseName(
  client: ReadOnlyQueryClient,
  timeoutMs = 5_000,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('identity query timed out')), timeoutMs)
  })
  try {
    const rows = (await Promise.race([client.$queryRaw`SELECT current_database() AS db`, timeout])) as Array<{ db?: unknown }>
    const value = rows[0]?.db
    return typeof value === 'string' ? value : null
  } finally {
    if (timer) clearTimeout(timer)
  }
}
