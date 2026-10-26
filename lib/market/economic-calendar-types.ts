export type EconomicEventItem = {
  id: string
  time: string
  title: string
  impact: string
  isTradable: boolean
  country: string
}

export type NewsCalendarPayload = {
  events: EconomicEventItem[]
  source: 'database' | 'fallback'
  syncedAt?: string
}
