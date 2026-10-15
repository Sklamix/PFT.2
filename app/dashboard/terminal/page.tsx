import type { Metadata } from 'next'
import { TerminalShell } from '@/components/terminal/TerminalShell'

export const metadata: Metadata = {
  title: 'Live Terminal — Professional Funded Trader',
  description: 'In-house execution desk with live FX quotes, order ticket, positions and risk rules.',
  robots: { index: false },
}

export default function TerminalPage() {
  return <TerminalShell />
}
