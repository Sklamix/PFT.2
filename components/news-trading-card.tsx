'use client'

import { useCallback, useEffect, useState } from 'react'
import { CalendarRange, Newspaper, Radio } from 'lucide-react'
import type { EconomicEventItem, NewsCalendarPayload } from '@/lib/market/economic-calendar-types'

const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })
const dayTimeFormat = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

function formatEventTime(value: string) {
  const date = new Date(value)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  return sameDay ? timeFormat.format(date) : dayTimeFormat.format(date)
}

function impactLabel(event: EconomicEventItem) {
  const impact = event.impact === 'HIGH' ? 'High' : event.impact === 'MEDIUM' ? 'Medium' : event.impact
  return event.isTradable ? `${impact} impact — Tradable` : `${impact} impact — Restricted`
}

function impactClass(event: EconomicEventItem) {
  if (!event.isTradable) return 'border-white/10 bg-white/[0.04] text-slate-500'
  if (event.impact === 'HIGH') return 'border-danger/20 bg-danger/10 text-danger'
  return 'border-warning/20 bg-warning/10 text-warning'
}

function useNewsCalendar() {
  const [payload, setPayload] = useState<NewsCalendarPayload>({ events: [], source: 'fallback' })
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/market/news-calendar', { cache: 'no-store' })
      if (!response.ok) return
      const next = (await response.json()) as NewsCalendarPayload
      if (Array.isArray(next.events)) setPayload(next)
    } catch {
      // Keep the last successful snapshot.
    } finally {
      setLoading(false)
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

  return { ...payload, loading }
}

export function NewsTradingCard() {
  const { events, loading } = useNewsCalendar()
  const visible = events.slice(0, 5)

  return (
    <article className="home-card cosmic-card flex flex-col gap-6 rounded-[1.75rem] p-6 lg:col-span-2">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-4">
          <div className="flex gap-2">
            <span className="flex size-10 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary shadow-[inset_0_0_20px_rgba(59,130,246,0.12)]">
              <Newspaper className="size-5" aria-hidden="true" />
            </span>
            <span className="flex size-10 items-center justify-center rounded-xl border border-highlight/25 bg-highlight/10 text-highlight shadow-[inset_0_0_20px_rgba(6,182,212,0.12)]">
              <Radio className="size-5" aria-hidden="true" />
            </span>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white sm:text-xl">News trading friendly with zero restrictions</h3>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-400">
              Trade high-impact macroeconomic releases instantly. Please note that all positions must be closed before
              market close / weekend, as overnight/weekend holding is currently not permitted.
            </p>
          </div>
        </div>
        <CalendarRange className="hidden size-5 text-slate-600 sm:block" aria-hidden="true" />
      </div>

      <ul className="divide-y divide-white/[0.06] rounded-xl border border-white/10 bg-black/25">
        {loading && visible.length === 0 ? (
          <li className="px-4 py-5 text-center text-sm text-slate-500">Loading economic calendar…</li>
        ) : visible.length === 0 ? (
          <li className="px-4 py-5 text-center text-sm text-slate-500">
            No high-impact releases are scheduled in the next sessions.
          </li>
        ) : (
          visible.map((event) => (
            <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm sm:flex-nowrap">
              <span className="flex min-w-0 items-center gap-3">
                <span className="w-[4.5rem] shrink-0 font-mono text-xs text-slate-500">{formatEventTime(event.time)}</span>
                <span className="min-w-0 truncate text-slate-200">
                  {event.title}
                  <span className="ml-2 font-mono text-[9px] uppercase tracking-wider text-slate-600">{event.country}</span>
                </span>
              </span>
              <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${impactClass(event)}`}>
                {impactLabel(event)}
              </span>
            </li>
          ))
        )}
      </ul>
      <p className="text-[10px] leading-relaxed text-slate-600">
        Calendar refreshes from the weekly economic feed and is checked hourly.
      </p>
    </article>
  )
}
