'use client'

import { create } from 'zustand'
import type { BillingOrder, BillingData } from '@/lib/dashboard/billing'

type BillingState = {
  data: BillingData | null
  loadState: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  invoiceId: string | null
  load: () => Promise<void>
  setInvoice: (id: string | null) => void
}

export const useBilling = create<BillingState>((set) => ({
  data: null,
  loadState: 'idle',
  error: null,
  invoiceId: null,

  load: async () => {
    set((state) => ({ loadState: state.data ? state.loadState : 'loading' }))
    try {
      const response = await fetch('/api/dashboard/billing', { cache: 'no-store' })
      if (response.status === 401) {
        window.location.assign(`/login?next=${encodeURIComponent('/dashboard/billing')}`)
        return
      }
      const data = (await response.json()) as BillingData
      if (!response.ok) throw new Error('Unable to load billing')
      set({ data, loadState: 'ready', error: null })
    } catch (err) {
      set({
        loadState: 'error',
        error: err instanceof Error ? err.message : 'Unable to load billing',
      })
    }
  },

  setInvoice: (id) => set({ invoiceId: id }),
}))

export type { BillingOrder }
