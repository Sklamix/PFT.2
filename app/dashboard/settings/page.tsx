import type { Metadata } from 'next'
import { SettingsShell } from '@/components/dashboard/settings-shell'

export const metadata: Metadata = {
  title: 'Settings — Professional Funded Trader',
  description: 'Manage your trader profile, account security and platform preferences.',
  robots: { index: false },
}

export default function SettingsPage() {
  return <SettingsShell />
}
