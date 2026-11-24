'use client'

import { useCallback, useEffect, useState } from 'react'

import { FALLBACK_PUBLIC_STATS } from '@/lib/stats/defaults'
import type { PublicStatsPayload } from '@/lib/stats/types'

/**
 * Single poller for the public platform stats. Shared by the payout section and
 * the hero so the homepage never opens two independent /api/stats loops.
 *
 * The bundled fallback is used until the first successful fetch; a failed fetch
 * keeps the last good snapshot rather than blanking the counters.
 */
export function usePublicStats(): PublicStatsPayload {
  const [payload, setPayload] = useState<PublicStatsPayload>(FALLBACK_PUBLIC_STATS)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/stats', { cache: 'no-store' })
      if (!response.ok) return
      const next = (await response.json()) as PublicStatsPayload
      if (next?.stats && Array.isArray(next.payouts)) setPayload(next)
    } catch {
      // Keep the last successful snapshot; the bundled fallback is used on first load.
    }
  }, [])

  useEffect(() => {
    void load()
    const interval = window.setInterval(() => void load(), 60_000)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load])

  return payload
}
