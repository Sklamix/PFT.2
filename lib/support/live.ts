import { ValidationError } from './types'

/** Parse the `since` query parameter: null when absent/blank, throws on invalid dates. */
export function parseSince(value: string | null): Date | null {
  if (value === null || value.trim() === '') return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError('Invalid since parameter.', 400)
  }
  return parsed
}

/** Merge lists by id: keeps existing order, appends unseen items in order. */
export function mergeMessages<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
  const seen = new Set(existing.map((item) => item.id))
  const merged = [...existing]
  for (const item of incoming) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    merged.push(item)
  }
  return merged
}

/** Latest ISO timestamp or null for empty arrays. */
export function latestCreatedAt<T extends { createdAt: string }>(items: T[]): string | null {
  let latest: string | null = null
  for (const item of items) {
    if (latest === null || item.createdAt > latest) latest = item.createdAt
  }
  return latest
}

/**
 * Label for the "new messages" pill.
 *
 * Ukrainian needs three plural forms (1 / 2-4 / 5+), English needs two.
 * Kept here rather than in the component so it can be unit-tested.
 */
export function newMessagesLabel(count: number, locale: 'en' | 'uk' = 'en'): string {
  const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
  if (locale === 'uk') {
    const mod10 = safe % 10
    const mod100 = safe % 100
    if (mod10 === 1 && mod100 !== 11) return `${safe} нове повідомлення`
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${safe} нові повідомлення`
    return `${safe} нових повідомлень`
  }
  return safe === 1 ? '1 new message' : `${safe} new messages`
}
