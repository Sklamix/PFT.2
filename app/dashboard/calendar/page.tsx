import type { Metadata } from 'next'
import { CalendarShell } from '@/components/dashboard/calendar-shell'

export const metadata: Metadata = {
  title: 'Economic Calendar — Professional Funded Trader',
  description: 'Track high-impact economic releases, volatility and news-window risk.',
  robots: { index: false },
}

export default function CalendarPage() {
  return <CalendarShell />
}
