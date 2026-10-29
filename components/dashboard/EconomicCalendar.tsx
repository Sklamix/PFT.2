'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Radio } from 'lucide-react'
import { cn } from '@/lib/utils'

type Impact = 'HIGH' | 'MEDIUM' | 'LOW'

export type CalendarEvent = {
  id: string
  date: string
  time: string
  currency: string
  event: string
  impact: Impact
  actual: string | null
  forecast: string | null
  previous: string | null
}

type ImpactFilter = 'all' | 'high' | 'highMedium'

const TIMEZONES = [
  { id: 'local', label: 'Local time' },
  { id: 'UTC', label: 'UTC' },
  { id: 'America/New_York', label: 'EST / EDT' },
  { id: 'Europe/Tallinn', label: 'EET / EEST' },
] as const

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'NZD']

const IMPACT_LABEL: Record<Impact, string> = { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' }

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function resolvedTimezone(id: string): string {
  return id === 'local' ? localTimezone() : id
}

function todayIn(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function eventDay(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso))
}

function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

function formatTimeIn(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

function prettyDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`)
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' })
}

function ImpactBadge({ impact }: { impact: Impact }) {
  if (impact === 'HIGH') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-red-400">
        <span className="relative flex size-1.5" aria-hidden="true">
          <span className="absolute inline-flex size-full motion-safe:animate-ping rounded-full bg-red-500 opacity-75" />
          <span className="relative inline-flex size-1.5 rounded-full bg-red-500 shadow-[0_0_8px_2px_rgba(239,68,68,0.6)]" />
        </span>
        High
      </span>
    )
  }
  if (impact === 'MEDIUM') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-400">
        <span className="size-1.5 rounded-full bg-amber-400" aria-hidden="true" />
        Medium
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-600/40 bg-slate-700/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
      <span className="size-1.5 rounded-full bg-slate-500" aria-hidden="true" />
      Low
    </span>
  )
}

export function EconomicCalendar({ compact = false }: { compact?: boolean }) {
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [timezone, setTimezone] = useState<string>('local')
  const [day, setDay] = useState<string>(() => todayIn('UTC'))
  const [impactFilter, setImpactFilter] = useState<ImpactFilter>('all')
  const [currencyFilter, setCurrencyFilter] = useState<string>('all')
  const [now, setNow] = useState<number>(Date.now())

  const tz = useMemo(() => resolvedTimezone(timezone), [timezone])

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/calendar', { cache: 'no-store' })
      if (!response.ok) return
      const data = (await response.json()) as { events?: CalendarEvent[] }
      if (Array.isArray(data.events)) setEvents(data.events)
    } catch {
      // Keep the last successful snapshot.
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const poll = window.setInterval(() => void load(), 60_000)
    const tick = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      window.clearInterval(poll)
      window.clearInterval(tick)
    }
  }, [load])

  // Keep the selected day in sync with the active timezone when the user hits "Today".
  useEffect(() => {
    setDay(todayIn(tz))
  }, [tz])

  const visible = useMemo(() => {
    return events
      .filter((event) => eventDay(event.date, tz) === day)
      .filter((event) => {
        if (impactFilter === 'high') return event.impact === 'HIGH'
        if (impactFilter === 'highMedium') return event.impact === 'HIGH' || event.impact === 'MEDIUM'
        return true
      })
      .filter((event) => currencyFilter === 'all' || event.currency === currencyFilter)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
  }, [events, day, tz, impactFilter, currencyFilter])

  const isToday = day === todayIn(tz)
  const nextUp = useMemo(
    () => events.filter((e) => e.impact === 'HIGH' && new Date(e.date).getTime() > now).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()),
    [events, now],
  )

  // Compact sidebar variant: just the next high-impact releases.
  if (compact) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            <Radio className="size-3" /> High-impact calendar
          </p>
          <a href="/dashboard/calendar" className="text-[11px] text-sky-400 hover:text-sky-300">
            Full calendar →
          </a>
        </div>
        {loading && nextUp.length === 0 ? (
          <p className="py-2 text-center text-xs text-slate-600">Loading…</p>
        ) : nextUp.length === 0 ? (
          <p className="py-2 text-center text-xs text-slate-600">No high-impact releases scheduled.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {nextUp.slice(0, 4).map((event) => (
              <li key={event.id} className="flex items-center justify-between gap-2 rounded-md border border-white/5 bg-white/[0.02] px-2.5 py-1.5 text-xs">
                <span className="min-w-0 truncate text-slate-300">{event.event}</span>
                <span className="shrink-0 font-mono text-slate-500">
                  {formatTimeIn(event.date, tz)} · {event.currency}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  return (
    <div className="min-h-dvh bg-transparent">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-sky-400">Economic calendar</p>
            <h1 className="mt-2 text-lg font-semibold tracking-tight text-slate-100">News &amp; releases</h1>
            <p className="mt-0.5 text-sm text-slate-400">Track high-impact releases that move volatility and risk.</p>
          </div>

          {/* Timezone selector */}
          <select
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            className="h-9 rounded-md border border-slate-800 bg-[#0B0F19]/80 px-3 text-sm text-slate-200 outline-none focus:border-slate-600"
            aria-label="Timezone"
          >
            {TIMEZONES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </header>

        {/* Filter bar */}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {/* Impact filter */}
          <div className="flex flex-wrap items-center gap-1">
            {(
              [
                ['all', 'All'],
                ['high', 'High only'],
                ['highMedium', 'High & Medium'],
              ] as [ImpactFilter, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setImpactFilter(value)}
                aria-pressed={impactFilter === value}
                className={cn(
                  'h-8 rounded-md px-3 text-xs transition-colors',
                  impactFilter === value ? 'bg-slate-800/60 text-slate-100' : 'text-slate-400 hover:text-slate-200',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Currency filter */}
          <select
            value={currencyFilter}
            onChange={(event) => setCurrencyFilter(event.target.value)}
            className="h-8 rounded-md border border-slate-800 bg-[#0B0F19]/80 px-2 font-mono text-xs text-slate-200 outline-none focus:border-slate-600"
            aria-label="Currency filter"
          >
            <option value="all">All currencies</option>
            {CURRENCIES.map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </select>
        </div>

        {/* Day navigation */}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setDay((d) => shiftDay(d, -1))}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-800 px-2 text-xs text-slate-300 hover:border-slate-600"
              aria-label="Previous day"
            >
              <ChevronLeft className="size-3.5" /> Prev
            </button>
            <button
              type="button"
              onClick={() => setDay(todayIn(tz))}
              className={cn(
                'h-8 rounded-md px-3 text-xs transition-colors',
                isToday ? 'bg-slate-800/60 text-slate-100' : 'border border-slate-800 text-slate-300 hover:border-slate-600',
              )}
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => setDay((d) => shiftDay(d, 1))}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-800 px-2 text-xs text-slate-300 hover:border-slate-600"
              aria-label="Next day"
            >
              Next <ChevronRight className="size-3.5" />
            </button>
          </div>

          <input
            type="date"
            value={day}
            onChange={(event) => event.target.value && setDay(event.target.value)}
            className="h-8 rounded-md border border-slate-800 bg-[#0B0F19]/80 px-2 font-mono text-xs text-slate-200 outline-none focus:border-slate-600"
            aria-label="Pick a date"
          />

          <p className="text-sm font-medium text-slate-300">{prettyDay(day)}</p>
        </div>

        {/* Events table */}
        <div className="mt-5 overflow-hidden rounded-xl border border-slate-800/80 bg-[#0B0F19]/80 backdrop-blur-md">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800/80 text-[10px] uppercase tracking-[0.16em] text-slate-500">
                <th className="px-4 py-2.5 font-medium">Time</th>
                <th className="px-3 py-2.5 font-medium">Currency</th>
                <th className="px-3 py-2.5 font-medium">Impact</th>
                <th className="px-3 py-2.5 font-medium">Event</th>
                <th className="px-3 py-2.5 text-right font-medium">Actual</th>
                <th className="px-3 py-2.5 text-right font-medium">Forecast</th>
                <th className="px-4 py-2.5 text-right font-medium">Previous</th>
              </tr>
            </thead>
            <tbody>
              {loading && visible.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    Loading economic calendar…
                  </td>
                </tr>
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    No events scheduled for this day.
                  </td>
                </tr>
              ) : (
                visible.map((event) => {
                  const eventTime = new Date(event.date).getTime()
                  const dueSoon = event.impact === 'HIGH' && eventTime > now && eventTime - now <= 15 * 60 * 1000
                  return (
                    <tr
                      key={event.id}
                      className={cn(
                        'border-b border-slate-800/40 last:border-0',
                        dueSoon && 'bg-red-500/[0.06]',
                      )}
                    >
                      <td className={cn('px-4 py-2.5 font-mono tabular-nums', dueSoon ? 'text-red-300' : 'text-slate-300')}>
                        {formatTimeIn(event.date, tz)}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-slate-400">{event.currency}</td>
                      <td className="px-3 py-2.5">
                        <ImpactBadge impact={event.impact} />
                      </td>
                      <td className="max-w-0 truncate px-3 py-2.5 text-slate-200">
                        {event.event}
                        {dueSoon ? <span className="ml-2 font-mono text-[10px] uppercase tracking-wider text-red-400">live soon</span> : null}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-200">{event.actual ?? '—'}</td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-400">{event.forecast ?? '—'}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-400">{event.previous ?? '—'}</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        <p className="mt-3 text-[11px] text-slate-600">
          Timezone: {TIMEZONES.find((option) => option.id === timezone)?.label}. Calendar refreshes from the weekly
          economic feed and is checked hourly.
        </p>
      </div>
    </div>
  )
}
