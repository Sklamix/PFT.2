'use client'

import { create } from 'zustand'

export type NotificationKind = 'order' | 'account' | 'payment' | 'rule' | 'system'
export type NotificationTone = 'success' | 'danger' | 'info' | 'warning'

export type NotificationRef = { kind: 'position' | 'pending'; id: string }

export type NotificationAction = {
  label: string
  /** Deep link rendered when provided (e.g. external checkout return URL). */
  href?: string
  /** In-terminal action rendered when provided (e.g. open the account). */
  onOpen?: () => void
}

export type NotificationItem = {
  id: string
  kind: NotificationKind
  tone: NotificationTone
  title: string
  message: string
  createdAt: number
  read: boolean
  /** Deep link target inside the terminal. */
  ref?: NotificationRef
  action?: NotificationAction
}

type NotificationInput = Omit<NotificationItem, 'createdAt' | 'read'> & { id: string }

type NotificationState = {
  items: NotificationItem[]
  push: (item: NotificationInput) => void
  markRead: (id: string) => void
  markAllRead: () => void
  remove: (id: string) => void
  clear: () => void
  hydrate: () => void
}

const MAX_ITEMS = 200
const STORAGE_KEY = 'pft:notifications:v1'

function persist(items: NotificationItem[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
  } catch {
    // Storage may be unavailable; the in-memory centre still works.
  }
}

function readPersisted(): NotificationItem[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as NotificationItem[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item) => item && typeof item.id === 'string' && typeof item.message === 'string')
  } catch {
    return []
  }
}

export const useNotifications = create<NotificationState>((set, get) => ({
  items: [],
  push: (item) => {
    const items = get().items
    // Idempotent: a repeated event must never create a duplicate row.
    if (items.some((entry) => entry.id === item.id)) return
    const next = [{ ...item, createdAt: Date.now(), read: false }, ...items].slice(0, MAX_ITEMS)
    set({ items: next })
    persist(next)
  },
  markRead: (id) =>
    set((state) => {
      const items = state.items.map((entry) => (entry.id === id ? { ...entry, read: true } : entry))
      persist(items)
      return { items }
    }),
  markAllRead: () => {
    const items = get().items.map((entry) => ({ ...entry, read: true }))
    set({ items })
    persist(items)
  },
  remove: (id) => {
    const items = get().items.filter((entry) => entry.id !== id)
    set({ items })
    persist(items)
  },
  clear: () => {
    set({ items: [] })
    try {
      window.localStorage.removeItem(STORAGE_KEY)
    } catch {
      // Ignore storage failures.
    }
  },
  hydrate: () => {
    set({ items: readPersisted() })
  },
}))
