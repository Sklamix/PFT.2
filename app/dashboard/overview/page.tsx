import type { Metadata } from 'next'
import { OverviewShell } from '@/components/dashboard/overview-shell'

export const metadata: Metadata = {
  title: 'Overview — Professional Funded Trader',
  description: 'Equity, PnL, drawdown guardrails and account progress at a glance.',
  robots: { index: false },
}

export default function OverviewPage() {
  return <OverviewShell />
}
