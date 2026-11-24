'use client'

import { create } from 'zustand'
import { isSupportedTimeZone as isSupported } from '@/lib/settings/timezones'

export const TIMEZONE_STORAGE_KEY = 'pft-terminal-timezone'
export const TIMEZONE_COOKIE = 'pft_tz'

export { TIMEZONE_OPTIONS, isSupportedTimeZone } from '@/lib/settings/timezones'

/**
 * Label for a zone's current offset, e.g. "GMT+2".
 *
 * Zero offset is normalised to "GMT" on purpose. Node and Chrome disagree here:
 * Node renders `shortOffset` for UTC/Europe/London as "GMT+0", Chrome as "GMT".
 * The header is server-rendered, so leaving that difference in place is a
 * hydration mismatch — React throws the whole tree away and re-renders it.
 */
export function timeZoneOffsetLabel(timeZone: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date())
    const raw = parts.find((part) => part.type === 'timeZoneName')?.value ?? ''
    return raw.replace(/^GMT[+-]0{1,2}(?::00)?$/, 'GMT')
  } catch {
    return ''
  }
}

type TimezoneStore = {
  timeZone: string
  setTimeZone: (timeZone: string) => void
}

export const useTimezoneStore = create<TimezoneStore>((set) => ({
  timeZone: 'UTC',
  setTimeZone: (timeZone) => {
    if (!isSupported(timeZone)) return
    set({ timeZone })
    try {
      window.localStorage.setItem(TIMEZONE_STORAGE_KEY, timeZone)
    } catch {
      // Storage may be unavailable (private mode); the selection still applies for this session.
    }
  },
}))

function cookieTimeZone() {
  try {
    const match = document.cookie.match(/(?:^|; )pft_tz=([^;]+)/)
    return match ? decodeURIComponent(match[1]!) : null
  } catch {
    return null
  }
}

/** Restores the saved zone once the client is mounted. Safe to call from an effect. */
export function loadStoredTimeZone() {
  try {
    const saved = window.localStorage.getItem(TIMEZONE_STORAGE_KEY)
    if (saved && isSupported(saved)) {
      useTimezoneStore.setState({ timeZone: saved })
      return
    }
    // Fall back to the account-level preference saved by the settings API (works on a fresh device).
    const fromCookie = cookieTimeZone()
    if (fromCookie && isSupported(fromCookie)) useTimezoneStore.setState({ timeZone: fromCookie })
  } catch {
    // Ignore unavailable storage.
  }
}
