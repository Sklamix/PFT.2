'use client'

import { useEffect, useState } from 'react'

type PublicStatus = 'operational' | 'degraded' | 'unavailable' | 'checking'

const COPY: Record<PublicStatus, { label: string; dot: string }> = {
  operational: {
    label: 'All systems operational',
    dot: 'bg-highlight shadow-[0_0_8px_2px_rgba(6,182,212,0.45)]',
  },
  degraded: {
    label: 'Degraded performance',
    dot: 'bg-amber-400 shadow-[0_0_8px_2px_rgba(251,191,36,0.45)]',
  },
  unavailable: {
    label: 'Service unavailable',
    dot: 'bg-red-500 shadow-[0_0_8px_2px_rgba(239,68,68,0.45)]',
  },
  checking: {
    label: 'Checking system status…',
    dot: 'bg-slate-500',
  },
}

/**
 * Replaces the hardcoded "All systems operational" footer string with the real state
 * reported by /api/health. Until the request resolves the badge stays neutral — a
 * never-verified green light is exactly the false signal this replaces.
 */
export function SystemStatusBadge() {
  const [status, setStatus] = useState<PublicStatus>('checking')

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    fetch('/api/health', { cache: 'no-store', signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('bad status'))))
      .then((payload: { status?: PublicStatus }) => {
        if (cancelled) return
        setStatus(payload.status === 'operational' || payload.status === 'degraded' || payload.status === 'unavailable' ? payload.status : 'unavailable')
      })
      .catch(() => {
        if (!cancelled) setStatus('unavailable')
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [])

  const copy = COPY[status]
  return (
    <p className="flex items-center gap-2 font-mono" role="status" aria-live="polite">
      <span className={`size-1.5 rounded-full ${copy.dot}`} aria-hidden="true" />
      {copy.label}
    </p>
  )
}
