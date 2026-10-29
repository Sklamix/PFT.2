export type EconomicEventItem = {
  id: string
  time: string
  title: string
  impact: string
  isTradable: boolean
  country: string
  forecast: string | null
  previous: string | null
  actual: string | null
}

export type NewsCalendarPayload = {
  events: EconomicEventItem[]
  source: 'database' | 'fallback'
  syncedAt?: string
}
