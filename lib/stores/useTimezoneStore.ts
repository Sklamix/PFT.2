'use client'

import { create } from 'zustand'
import { isSupportedTimeZone as isSupported } from '@/lib/settings/timezones'

export const TIMEZONE_STORAGE_KEY = 'pft-terminal-timezone'
export const TIMEZONE_COOKIE = 'pft_tz'

export { TIMEZONE_OPTIONS, isSupportedTimeZone } from '@/lib/settings/timezones'

export function timeZoneOffsetLabel(timeZone: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date())
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? ''
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
