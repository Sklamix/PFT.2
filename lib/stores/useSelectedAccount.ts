'use client'

import { create } from 'zustand'

/**
 * Globally selected trading account, shared between the Overview cockpit and
 * the Payouts & Certificates page so both views always show the same account.
 */
type SelectedAccountState = {
  accountId: string
  select: (id: string) => void
}

export const useSelectedAccount = create<SelectedAccountState>((set) => ({
  accountId: '',
  select: (id) => set({ accountId: id }),
}))
