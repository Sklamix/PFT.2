'use client'

import { create } from 'zustand'
import type { AccountRow, AccountsData, AccountTrade } from '@/lib/dashboard/accounts'

type AccountsState = {
  data: AccountsData | null
  loadState: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  filter: 'all' | 'active' | 'funded' | 'archived'
  expandedId: string | null
  load: () => Promise<void>
  setFilter: (filter: AccountsState['filter']) => void
  toggleExpanded: (id: string) => void
}

export const useAccounts = create<AccountsState>((set, get) => ({
  data: null,
  loadState: 'idle',
  error: null,
  filter: 'all',
  expandedId: null,

  load: async () => {
    set((state) => ({ loadState: state.data ? state.loadState : 'loading' }))
    try {
      const response = await fetch('/api/dashboard/accounts', { cache: 'no-store' })
      if (response.status === 401) {
        window.location.assign(`/login?next=${encodeURIComponent('/dashboard/accounts')}`)
        return
      }
      const data = (await response.json()) as AccountsData
      if (!response.ok) throw new Error('Unable to load trading accounts')
      set({ data, loadState: 'ready', error: null })
    } catch (err) {
      set({
        loadState: 'error',
        error: err instanceof Error ? err.message : 'Unable to load trading accounts',
      })
    }
  },

  setFilter: (filter) => {
    set({ filter, expandedId: null })
  },

  toggleExpanded: (id) => {
    const current = get().expandedId
    set({ expandedId: current === id ? null : id })
  },
}))

export type { AccountRow, AccountTrade }
