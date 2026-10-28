'use client'

import { create } from 'zustand'
import type { CertificateCard, PayoutRow, PayoutsData } from '@/lib/dashboard/payouts'

type Tab = 'payouts' | 'certificates'

type PayoutsState = {
  data: PayoutsData | null
  loadState: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  tab: Tab
  requestOpen: boolean
  previewId: string | null
  load: () => Promise<void>
  setTab: (tab: Tab) => void
  setRequestOpen: (open: boolean) => void
  setPreview: (id: string | null) => void
}

export const usePayouts = create<PayoutsState>((set) => ({
  data: null,
  loadState: 'idle',
  error: null,
  tab: 'payouts',
  requestOpen: false,
  previewId: null,

  load: async () => {
    set((state) => ({ loadState: state.data ? state.loadState : 'loading' }))
    try {
      const response = await fetch('/api/dashboard/payouts', { cache: 'no-store' })
      if (response.status === 401) {
        window.location.assign(`/login?next=${encodeURIComponent('/dashboard/payouts')}`)
        return
      }
      const data = (await response.json()) as PayoutsData
      if (!response.ok) throw new Error('Unable to load payouts')
      set({ data, loadState: 'ready', error: null })
    } catch (err) {
      set({
        loadState: 'error',
        error: err instanceof Error ? err.message : 'Unable to load payouts',
      })
    }
  },

  setTab: (tab) => set({ tab, previewId: null }),
  setRequestOpen: (open) => set({ requestOpen: open }),
  setPreview: (id) => set({ previewId: id }),
}))

export type { CertificateCard, PayoutRow }
