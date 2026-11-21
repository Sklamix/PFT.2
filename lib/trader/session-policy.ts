/**
 * Single predicate for "may this user hold a trader session?".
 *
 * Archived traders must not be able to sign in or keep an existing session,
 * regardless of the authentication method (password, email code, Google OAuth).
 * Keeping the rule in one pure function prevents auth paths from drifting apart.
 */
export function isActiveTraderUser(
  user: { role: string; archivedAt: Date | null } | null | undefined,
): boolean {
  return Boolean(user && user.role === 'TRADER' && user.archivedAt == null)
}
