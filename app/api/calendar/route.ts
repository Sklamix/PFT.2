import { NextResponse } from 'next/server'
import { getEconomicCalendarEvents } from '@/lib/market/economic-calendar'

export const revalidate = 300

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export type CalendarEvent = {
  id: string
  date: string
  time: string
  currency: string
  event: string
  impact: 'HIGH' | 'MEDIUM' | 'LOW'
  actual: string | null
  forecast: string | null
  previous: string | null
}

function toHhMm(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--:--'
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const now = Date.now()

  // Optional window; defaults to a rolling week-plus-ahead for the widget.
  const from = url.searchParams.get('from') ? new Date(url.searchParams.get('from')!) : new Date(now - 12 * HOUR_MS)
  const to = url.searchParams.get('to') ? new Date(url.searchParams.get('to')!) : new Date(now + 8 * DAY_MS)

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    return NextResponse.json({ error: 'Invalid date window' }, { status: 400 })
  }

  try {
    const events = await getEconomicCalendarEvents(from, to)
    const mapped: CalendarEvent[] = events.map((event) => ({
      id: event.id,
      date: event.time,
      time: toHhMm(event.time),
      currency: event.country,
      event: event.title,
      impact: (event.impact === 'HIGH' ? 'HIGH' : event.impact === 'LOW' ? 'LOW' : 'MEDIUM'),
      actual: event.actual,
      forecast: event.forecast,
      previous: event.previous,
    }))
    return NextResponse.json({ events: mapped })
  } catch (error) {
    console.error('[pft calendar] Failed to load economic calendar', error)
    return NextResponse.json({ events: [], source: 'fallback' })
  }
}
