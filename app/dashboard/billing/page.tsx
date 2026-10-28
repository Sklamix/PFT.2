import type { Metadata } from 'next'
import { BillingShell } from '@/components/dashboard/billing-shell'

export const metadata: Metadata = {
  title: 'Billing & Orders — Professional Funded Trader',
  description: 'Challenge purchase history, crypto payment status and receipts.',
  robots: { index: false },
}

export default function BillingPage() {
  return <BillingShell />
}
