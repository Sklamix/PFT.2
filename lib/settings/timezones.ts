/** Timezones offered in the trader settings. Server-safe (no client imports). */
export const TIMEZONE_OPTIONS = [
  { value: 'UTC', label: 'UTC' },
  { value: 'Europe/Kyiv', label: 'Kyiv' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Berlin', label: 'Berlin' },
  { value: 'Europe/Zurich', label: 'Zurich' },
  { value: 'Europe/Warsaw', label: 'Warsaw' },
  { value: 'America/New_York', label: 'New York' },
  { value: 'America/Chicago', label: 'Chicago' },
  { value: 'America/Los_Angeles', label: 'Los Angeles' },
  { value: 'America/Sao_Paulo', label: 'São Paulo' },
  { value: 'Asia/Dubai', label: 'Dubai' },
  { value: 'Asia/Karachi', label: 'Karachi' },
  { value: 'Asia/Singapore', label: 'Singapore' },
  { value: 'Asia/Tokyo', label: 'Tokyo' },
  { value: 'Australia/Sydney', label: 'Sydney' },
] as const

export type TimezoneValue = (typeof TIMEZONE_OPTIONS)[number]['value']

export function isSupportedTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}
