import { createHash } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import type { EconomicEventItem, NewsCalendarPayload } from './economic-calendar-types'

// The public ForexFactory feed exposes the current week. Next-week files are not
// available on the same host, so the hourly sync refreshes the current calendar.
const FEEDS = ['https://nfs.faireconomy.media/ff_calendar_thisweek.json']

type FeedEvent = {
  title?: unknown
  country?: unknown
  date?: unknown
  impact?: unknown
  forecast?: unknown
  previous?: unknown
  actual?: unknown
}

const ALLOWED_IMPACTS = new Set(['HIGH', 'MEDIUM', 'LOW'])

function externalIdFor(country: string, title: string, time: Date) {
  return createHash('sha1').update(`${country}|${title}|${time.toISOString()}`).digest('hex')
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

async function fetchFeed(url: string) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'PFT-EconomicCalendar/1.0' },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Economic calendar feed responded ${response.status}`)
  const payload = await response.json()
  return Array.isArray(payload) ? payload as FeedEvent[] : []
}

export async function syncEconomicCalendar() {
  const results = await Promise.allSettled(FEEDS.map(fetchFeed))
  const events = new Map<string, {
    time: Date
    title: string
    impact: string
    country: string
    forecast: string | null
    previous: string | null
    actual: string | null
    externalId: string
  }>()

  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('[pft calendar] Feed failed', result.reason)
      continue
    }
    for (const raw of result.value) {
      const title = typeof raw.title === 'string' ? raw.title.trim() : ''
      const country = typeof raw.country === 'string' ? raw.country.trim().toUpperCase() : ''
      const impact = typeof raw.impact === 'string' ? raw.impact.trim().toUpperCase() : ''
      const time = typeof raw.date === 'string' ? new Date(raw.date) : null
      if (!title || !country || !time || Number.isNaN(time.getTime())) continue
      if (!ALLOWED_IMPACTS.has(impact)) continue
      const externalId = externalIdFor(country, title, time)
      events.set(externalId, {
        time,
        title,
        impact,
        country,
        forecast: optionalString(raw.forecast),
        previous: optionalString(raw.previous),
        actual: optionalString(raw.actual),
        externalId,
      })
    }
  }

  if (events.size === 0) throw new Error('No economic events were available from the calendar feeds')

  const now = Date.now()
  await prisma.$transaction(async (tx) => {
    for (const event of events.values()) {
      await tx.economicEvent.upsert({
        where: { externalId: event.externalId },
        create: {
          externalId: event.externalId,
          time: event.time,
          title: event.title,
          impact: event.impact,
          isTradable: true,
          country: event.country,
          forecast: event.forecast,
          previous: event.previous,
          actual: event.actual,
        },
        update: {
          time: event.time,
          title: event.title,
          impact: event.impact,
          isTradable: true,
          country: event.country,
          forecast: event.forecast,
          previous: event.previous,
          actual: event.actual,
        },
      })
    }

    await tx.economicEvent.deleteMany({
      where: { time: { lt: new Date(now - 2 * 24 * 60 * 60_000) } },
    })
  })

  return events.size
}

function serializeEvent(row: {
  id: string
  time: Date
  title: string
  impact: string
  isTradable: boolean
  country: string
  forecast: string | null
  previous: string | null
  actual: string | null
}): EconomicEventItem {
  return {
    id: row.id,
    time: row.time.toISOString(),
    title: row.title,
    impact: row.impact,
    isTradable: row.isTradable,
    country: row.country,
    forecast: row.forecast,
    previous: row.previous,
    actual: row.actual,
  }
}

export async function getUpcomingEconomicEvents(limit = 8): Promise<NewsCalendarPayload> {
  const since = new Date(Date.now() - 30 * 60_000)
  const query = () => prisma.economicEvent.findMany({
    where: {
      time: { gte: since },
      impact: { in: ['HIGH', 'MEDIUM'] },
    },
    orderBy: { time: 'asc' },
    take: limit,
  })

  let rows = await query()
  if (rows.length === 0) {
    try {
      await syncEconomicCalendar()
      rows = await query()
    } catch (error) {
      console.warn('[pft calendar] No cached events and sync failed', error)
    }
  }

  return {
    events: rows.map(serializeEvent),
    source: rows.length ? 'database' : 'fallback',
  }
}

export async function getLastEconomicSyncAt() {
  const latest = await prisma.economicEvent.findFirst({
    orderBy: { updatedAt: 'desc' },
    select: { updatedAt: true },
  })
  return latest?.updatedAt ?? null
}

/**
 * Full economic calendar for the trader widget: all impact levels across a date
 * window. Returns the requested frontend shape (currency, event name, impact,
 * actual/forecast/previous).
 */
export async function getEconomicCalendarEvents(from: Date, to: Date): Promise<EconomicEventItem[]> {
  let rows = await prisma.economicEvent.findMany({
    where: { time: { gte: from, lte: to } },
    orderBy: { time: 'asc' },
    take: 400,
  })

  if (rows.length === 0) {
    try {
      await syncEconomicCalendar()
      rows = await prisma.economicEvent.findMany({
        where: { time: { gte: from, lte: to } },
        orderBy: { time: 'asc' },
        take: 400,
      })
    } catch (error) {
      console.warn('[pft calendar] No cached events in window and sync failed', error)
    }
  }

  return rows.map(serializeEvent)
}
