'use client'

import { create } from 'zustand'
import { TERMINAL_SYMBOLS, type TerminalSymbolId } from '@/lib/constants/symbols'

export const FAVORITES_STORAGE_KEY = 'pft_favorite_symbols'

function sanitizeFavorites(value: unknown): TerminalSymbolId[] {
  if (!Array.isArray(value)) return []
  const valid = new Set<string>(TERMINAL_SYMBOLS)
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && valid.has(item)))] as TerminalSymbolId[]
}

function persistLocal(favorites: TerminalSymbolId[]) {
  try {
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favorites))
  } catch {
    // Storage can be unavailable (private mode); favorites still work for this session.
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
function persistServer(favorites: TerminalSymbolId[]) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void fetch('/api/trading/favorites', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favorites }),
    }).catch((error) => {
      console.warn('[pft favorites] Failed to save on server', error)
    })
  }, 250)
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
    persistLocal(next)
    persistServer(next)
    set({ favorites: next })
  },
}))

/**
 * Restores favorites from the account first (cross-device), falling back to the
 * browser cache and seeding the account with existing local favorites once.
 */
export async function loadStoredFavorites() {
  let local: TerminalSymbolId[] = []
  try {
    local = sanitizeFavorites(JSON.parse(window.localStorage.getItem(FAVORITES_STORAGE_KEY) ?? '[]'))
    if (local.length > 0) useFavoritesStore.setState({ favorites: local })
  } catch {
    // Ignore malformed or unavailable storage.
  }

  try {
    const response = await fetch('/api/trading/favorites', { cache: 'no-store' })
    if (!response.ok) return
    const data = (await response.json()) as { favorites?: unknown }
    const remote = sanitizeFavorites(data.favorites)
    if (remote.length > 0) {
      useFavoritesStore.setState({ favorites: remote })
      persistLocal(remote)
    } else if (local.length > 0) {
      // First load after server-side favorites were introduced: migrate the browser list.
      persistServer(local)
    }
  } catch {
    // Keep the local cache when offline or unauthenticated.
  }
}
