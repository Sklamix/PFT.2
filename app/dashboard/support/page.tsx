import type { Metadata } from 'next'
import { SupportShell } from '@/components/dashboard/support-shell'

export const metadata: Metadata = {
  title: 'Support — Professional Funded Trader',
  description: 'Contact the PFT support desk and track your requests.',
  robots: { index: false },
}

export default function SupportPage() {
  return <SupportShell />
}
