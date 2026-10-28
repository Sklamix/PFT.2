import type { Metadata } from 'next'
import { AccountsShell } from '@/components/dashboard/accounts-shell'

export const metadata: Metadata = {
  title: 'Trading Accounts — Professional Funded Trader',
  description: 'Manage your evaluation and funded accounts, credentials and analytics.',
  robots: { index: false },
}

export default function AccountsPage() {
  return <AccountsShell />
}
