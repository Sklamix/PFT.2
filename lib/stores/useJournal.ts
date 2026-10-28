'use client'

import { create } from 'zustand'
import type { JournalTrade } from '@/lib/dashboard/journal'

export type JournalFilters = {
  range: '7d' | '30d' | '90d' | 'all'
  symbol: string
  side: 'all' | 'BUY' | 'SELL'
}

type JournalState = {
  data: JournalTrade[] | null
  loadState: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  filters: JournalFilters
  openTradeId: string | null
  load: () => Promise<void>
  setFilters: (filters: Partial<JournalFilters>) => void
  setOpenTrade: (id: string | null) => void
}

export const useJournal = create<JournalState>((set) => ({
  data: null,
  loadState: 'idle',
  error: null,
  filters: { range: '30d', symbol: 'all', side: 'all' },
  openTradeId: null,

  load: async () => {
    set((state) => ({ loadState: state.data ? state.loadState : 'loading' }))
    try {
      const response = await fetch('/api/dashboard/journal', { cache: 'no-store' })
      if (response.status === 401) {
        window.location.assign(`/login?next=${encodeURIComponent('/dashboard/journal')}`)
        return
      }
      const data = (await response.json()) as { trades?: JournalTrade[] }
      if (!response.ok) throw new Error('Unable to load journal')
      set({ data: data.trades ?? [], loadState: 'ready', error: null })
    } catch (err) {
      set({
        loadState: 'error',
        error: err instanceof Error ? err.message : 'Unable to load journal',
      })
    }
  },

  setFilters: (filters) => set((state) => ({ filters: { ...state.filters, ...filters } })),
  setOpenTrade: (id) => set({ openTradeId: id }),
}))

export type { JournalTrade }
