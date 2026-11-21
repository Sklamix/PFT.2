import type { GateAction } from './observability-db-gate'
import { validateDedicatedTestUrl } from './observability-db-gate'

/**
 * Controlled allowlist of roles authorized to run TEST migrations.
 * Only the dedicated migrator may execute migrations.
 *
 * All other roles (including 'pft_test_runtime' and 'neondb_owner') are rejected.
 */
export const ALLOWED_MIGRATION_ROLES: readonly string[] = [
  'pft_test_migrator',
] as const

export type AllowedMigrationRole = (typeof ALLOWED_MIGRATION_ROLES)[number]

/** Default/legacy alias kept for callers expecting a single reference string. */
export const REQUIRED_MIGRATION_ROLE: AllowedMigrationRole = 'pft_test_migrator'
export const FORBIDDEN_MIGRATION_ROLE = 'pft_test_runtime'

export const FORBIDDEN_MIGRATION_ROLES: readonly string[] = [
  'pft_test_runtime',
  'neondb_owner',
  'pft_test_init',
] as const

export function isAllowedMigrationRole(role: string): role is AllowedMigrationRole {
  return (ALLOWED_MIGRATION_ROLES as readonly string[]).includes(role)
}

export function resolveMigrationTestDb(
  env: Record<string, string | undefined> = process.env,
): GateAction {
  const rawUrl = (env.MIGRATION_DATABASE_URL ?? '').trim()
  if (!rawUrl) {
    return {
      action: 'stop',
      reason: 'MIGRATION_DATABASE_URL is required — refusing (no DATABASE_URL fallback for migrations)',
    }
  }

  // The shared validator rejects production hosts, poolers, non-/pft_dbtest paths,
  // non-5432 ports, forbidden params and non-strict TLS settings.
  const validated = validateDedicatedTestUrl(rawUrl)
  if (validated.action !== 'use') return validated

  const role = (env.MIGRATION_EXPECTED_ROLE ?? '').trim()
  if (!role) {
    return {
      action: 'stop',
      reason: 'MIGRATION_EXPECTED_ROLE is required — refusing (migration executor role must be pinned)',
    }
  }
  if (role === 'pft_test_runtime') {
    return {
      action: 'stop',
      reason: `runtime role 'pft_test_runtime' must not be used for migrations — allowed: ${ALLOWED_MIGRATION_ROLES.join(', ')}`,
    }
  }
  if (role === 'neondb_owner') {
    return {
      action: 'stop',
      reason: `admin role 'neondb_owner' must not be used for migrations — allowed: ${ALLOWED_MIGRATION_ROLES.join(', ')}`,
    }
  }
  if (!isAllowedMigrationRole(role)) {
    return {
      action: 'stop',
      reason: `MIGRATION_EXPECTED_ROLE '${role}' is not an allowed migration role (must be one of: ${ALLOWED_MIGRATION_ROLES.join(', ')})`,
    }
  }
  return validated
}
