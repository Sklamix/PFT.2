/** FXCM's XML Last field is a GMT clock time (HH:MM:SS) without a date. */
export function parseGmtTimeOfDay(value: string | undefined, at: Date = new Date()): number {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(value?.trim() ?? '')
  if (!match) return 0

  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  if (hours > 23 || minutes > 59 || seconds > 59) return 0

  const timestamp = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), hours, minutes, seconds)
  // A clock a little ahead of ours is still today; a larger jump means the previous day.
  return timestamp > at.getTime() + 60_000 ? timestamp - 86_400_000 : timestamp
}

export const QUOTE_MAX_AGE_MS = 3_000

export function isFreshQuote(feedTime: number, at: Date = new Date()): boolean {
  if (!Number.isFinite(feedTime) || feedTime <= 0) return false
  const age = at.getTime() - feedTime
  return age >= -QUOTE_MAX_AGE_MS && age <= QUOTE_MAX_AGE_MS
}
