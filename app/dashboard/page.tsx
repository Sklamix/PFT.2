import type { Metadata } from 'next'
import { DashboardShell } from '@/components/dashboard/dashboard-shell'

export const metadata: Metadata = {
  title: 'Trader Terminal — Professional Funded Trader',
  description: 'Monitor drawdown guardrails, trading objectives, equity curve, trades and payouts for your PFT accounts.',
  robots: { index: false },
}

export default function DashboardPage() {
  return <DashboardShell />
}
