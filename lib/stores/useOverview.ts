'use client'

import { create } from 'zustand'
import type { EquityPoint, OverviewAccount, OverviewData } from '@/lib/dashboard/overview'

type OverviewState = {
  data: OverviewData | null
  loadState: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  selectedAccountId: string
  load: () => Promise<void>
  select: (id: string) => void
}

export const useOverview = create<OverviewState>((set, get) => ({
  data: null,
  loadState: 'idle',
  error: null,
  selectedAccountId: '',

  load: async () => {
    set((state) => ({ loadState: state.data ? state.loadState : 'loading' }))
    try {
      const response = await fetch('/api/dashboard/overview', { cache: 'no-store' })
      if (response.status === 401) {
        window.location.assign(`/login?next=${encodeURIComponent('/dashboard/overview')}`)
        return
      }
      const data = (await response.json()) as OverviewData
      if (!response.ok) throw new Error('Unable to load overview')
      set((state) => {
        const accounts = data.accounts ?? []
        const selected = accounts.some((account) => account.id === state.selectedAccountId)
          ? state.selectedAccountId
          : (accounts[0]?.id ?? '')
        return { data, loadState: 'ready', error: null, selectedAccountId: selected }
      })
    } catch (err) {
      set({
        loadState: 'error',
        error: err instanceof Error ? err.message : 'Unable to load overview',
      })
    }
  },

  select: (id) => set({ selectedAccountId: id }),
}))

export type { EquityPoint, OverviewAccount, OverviewData }
