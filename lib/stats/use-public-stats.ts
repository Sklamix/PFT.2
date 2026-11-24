'use client'

import { useSyncExternalStore } from 'react'

import { FALLBACK_PUBLIC_STATS } from '@/lib/stats/defaults'
import type { PublicStatsPayload } from '@/lib/stats/types'

const REFRESH_MS = 60_000

let snapshot: PublicStatsPayload = FALLBACK_PUBLIC_STATS
const listeners = new Set<() => void>()
let started = false

function emit() {
  for (const listener of listeners) listener()
}

async function refresh() {
  try {
    const response = await fetch('/api/stats', { cache: 'no-store' })
    if (!response.ok) return
    const next = (await response.json()) as PublicStatsPayload
    if (!next?.stats || !Array.isArray(next.payouts) || !next.proofs) return
    snapshot = next
    emit()
  } catch {
    // Keep the last successful snapshot; the bundled fallback covers first load.
  }
}

/**
 * One poller for the whole page, started by the first subscriber. The hero and the
 * payout section read the same module-level snapshot, so the homepage never opens
 * two independent /api/stats loops.
 *
 * The bundled fallback is used until the first successful fetch; a failed fetch
 * keeps the last good snapshot rather than blanking the counters.
 */
function subscribe(listener: () => void) {
  listeners.add(listener)

  if (!started && typeof window !== 'undefined') {
    started = true
    void refresh()
    window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, REFRESH_MS)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void refresh()
    })
  }

  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot() {
  return snapshot
}

function getServerSnapshot() {
  return FALLBACK_PUBLIC_STATS
}

export function usePublicStats(): PublicStatsPayload {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
