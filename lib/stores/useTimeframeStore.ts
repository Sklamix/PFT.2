'use client'

import { create } from 'zustand'
import { parseTimeframe, TIMEFRAMES, type TimeframeSpec } from '@/lib/terminal/candles'

export const TIMEFRAMES_STORAGE_KEY = 'pft_favorite_timeframes'

/** The six timeframes a new terminal starts with. */
const POPULAR_IDS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const

export const DEFAULT_TIMEFRAMES: TimeframeSpec[] = POPULAR_IDS.flatMap((id) => {
  const preset = TIMEFRAMES.find((item) => item.id === id)
  return preset ? [{ ...preset, custom: false }] : []
})

type StoredTimeframes = {
  favorites: TimeframeSpec[]
  selected: string
}

function persist(favorites: TimeframeSpec[], selected: string) {
  try {
    window.localStorage.setItem(TIMEFRAMES_STORAGE_KEY, JSON.stringify({ favorites, selected }))
  } catch {
    // Storage can be unavailable (private mode); favorites still work for this session.
  }
}

type TimeframeStore = {
  favorites: TimeframeSpec[]
  selected: string
  select: (timeframe: TimeframeSpec) => void
  toggleFavorite: (timeframe: TimeframeSpec) => void
  addCustom: (amount: string, unit: 'm' | 'h' | 'd') => TimeframeSpec | null
}

export const useTimeframeStore = create<TimeframeStore>((set, get) => ({
  favorites: DEFAULT_TIMEFRAMES,
  selected: '5m',

  select: (timeframe) => {
    const current = get().favorites
    const favorites = current.some((item) => item.id === timeframe.id) ? current : [...current, timeframe]
    persist(favorites, timeframe.id)
    set({ favorites, selected: timeframe.id })
  },

  toggleFavorite: (timeframe) => {
    const { favorites, selected } = get()
    const exists = favorites.some((item) => item.id === timeframe.id)
    if (exists && favorites.length === 1) return
    const next = exists ? favorites.filter((item) => item.id !== timeframe.id) : [...favorites, timeframe]
    const nextSelected = exists && selected === timeframe.id ? next[0].id : selected
    persist(next, nextSelected)
    set({ favorites: next, selected: nextSelected })
  },

  addCustom: (amount, unit) => {
    const spec = parseTimeframe(`${amount.trim()}${unit}`)
    if (!spec) return null
    const favorites = get().favorites
    const next = favorites.some((item) => item.id === spec.id) ? favorites : [...favorites, spec]
    persist(next, spec.id)
    set({ favorites: next, selected: spec.id })
    return spec
  },
}))

/** Restores saved timeframes once the client is mounted. Safe to call from an effect. */
export function loadStoredTimeframes() {
  try {
    const raw = window.localStorage.getItem(TIMEFRAMES_STORAGE_KEY)
    if (!raw) return
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const data = parsed as Partial<StoredTimeframes>
    if (!Array.isArray(data.favorites)) return

    const favorites = data.favorites.flatMap((value): TimeframeSpec[] => {
      if (!value || typeof value !== 'object') return []
      const id = (value as { id?: unknown }).id
      if (typeof id !== 'string') return []
      const spec = parseTimeframe(id)
      return spec ? [spec] : []
    })
    const unique = [...new Map(favorites.map((item) => [item.id, item])).values()]
    if (!unique.length) return
    const selected = typeof data.selected === 'string' && unique.some((item) => item.id === data.selected) ? data.selected : unique[0].id
    useTimeframeStore.setState({ favorites: unique, selected })
  } catch {
    // Ignore malformed or unavailable storage.
  }
}
