import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

export const metadata: Metadata = {
  title: 'Trader Terminal — Professional Funded Trader',
  description: 'Monitor drawdown guardrails, trading objectives, equity curve, trades and payouts for your PFT accounts.',
  robots: { index: false },
}

export default function DashboardPage() {
  redirect('/dashboard/terminal')
}
