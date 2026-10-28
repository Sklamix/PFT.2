import type { Metadata } from 'next'
import { JournalShell } from '@/components/dashboard/journal-shell'

export const metadata: Metadata = {
  title: 'Trading Journal — Professional Funded Trader',
  description: 'Review closed trades, tag setups, save reflective notes and chart screenshots.',
  robots: { index: false },
}

export default function JournalPage() {
  return <JournalShell />
}
