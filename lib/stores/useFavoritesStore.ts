'use client'

import { create } from 'zustand'
import { TERMINAL_SYMBOLS, type TerminalSymbolId } from '@/lib/constants/symbols'

export const FAVORITES_STORAGE_KEY = 'pft_favorite_symbols'

function isTerminalSymbol(value: string): value is TerminalSymbolId {
  return (TERMINAL_SYMBOLS as readonly string[]).includes(value)
}

function persist(favorites: string[]) {
  try {
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favorites))
  } catch {
    // Storage can be unavailable (private mode); favorites still work for this session.
  }
}

type FavoritesStore = {
  favorites: TerminalSymbolId[]
  toggleFavorite: (symbol: TerminalSymbolId) => void
}

export const useFavoritesStore = create<FavoritesStore>((set, get) => ({
  favorites: [],
  toggleFavorite: (symbol) => {
    const current = get().favorites
    const next = current.includes(symbol) ? current.filter((item) => item !== symbol) : [...current, symbol]
    persist(next)
    set({ favorites: next })
  },
}))

/** Restores saved favorites once the client is mounted. Safe to call from an effect. */
export function loadStoredFavorites() {
  try {
    const raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY)
    if (!raw) return
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return
    const favorites = parsed.filter((value): value is TerminalSymbolId => typeof value === 'string' && isTerminalSymbol(value))
    useFavoritesStore.setState({ favorites: [...new Set(favorites)] })
  } catch {
    // Ignore malformed or unavailable storage.
  }
}
