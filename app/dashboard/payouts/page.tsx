import type { Metadata } from 'next'
import { PayoutsShell } from '@/components/dashboard/payouts-shell'

export const metadata: Metadata = {
  title: 'Payouts & Certificates — Professional Funded Trader',
  description: 'Request crypto payouts and download earned trader certificates.',
  robots: { index: false },
}

export default function PayoutsPage() {
  return <PayoutsShell />
}
