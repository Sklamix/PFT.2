'use client'

import { create } from 'zustand'

export const TIMEZONE_STORAGE_KEY = 'pft-terminal-timezone'

export const TIMEZONE_OPTIONS = [
  { value: 'UTC', label: 'UTC' },
  { value: 'Europe/Kyiv', label: 'Kyiv' },
  { value: 'Europe/London', label: 'London' },
  { value: 'America/New_York', label: 'New York' },
  { value: 'America/Chicago', label: 'Chicago' },
  { value: 'Europe/Berlin', label: 'Berlin' },
  { value: 'Asia/Dubai', label: 'Dubai' },
  { value: 'Asia/Singapore', label: 'Singapore' },
  { value: 'Asia/Tokyo', label: 'Tokyo' },
  { value: 'Australia/Sydney', label: 'Sydney' },
] as const

export function isSupportedTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

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
    if (!isSupportedTimeZone(timeZone)) return
    set({ timeZone })
    try {
      window.localStorage.setItem(TIMEZONE_STORAGE_KEY, timeZone)
    } catch {
      // Storage may be unavailable (private mode); the selection still applies for this session.
    }
  },
}))

/** Restores the saved zone once the client is mounted. Safe to call from an effect. */
export function loadStoredTimeZone() {
  try {
    const saved = window.localStorage.getItem(TIMEZONE_STORAGE_KEY)
    if (saved && isSupportedTimeZone(saved)) useTimezoneStore.setState({ timeZone: saved })
  } catch {
    // Ignore unavailable storage.
  }
}
