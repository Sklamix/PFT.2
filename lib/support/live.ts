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
