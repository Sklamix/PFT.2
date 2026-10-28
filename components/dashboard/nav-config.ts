import { Award, BookOpen, CandlestickChart, Layers, LayoutDashboard, Receipt, ShieldCheck } from 'lucide-react'

export const DASHBOARD_VIEWS = [
  { id: 'overview', label: 'Overview / Cockpit', icon: LayoutDashboard, href: '/dashboard/overview' },
  { id: 'accounts', label: 'Trading Accounts', icon: Layers, href: '/dashboard/accounts' },
  { id: 'payouts', label: 'Payouts & Certificates', icon: Award, href: '/dashboard/payouts' },
  { id: 'journal', label: 'Trading Journal', icon: BookOpen, href: '/dashboard/journal' },
  { id: 'billing', label: 'Billing & Orders', icon: Receipt, href: '/dashboard/billing' },
  { id: 'settings', label: 'Settings & KYC', icon: ShieldCheck },
] as const

export type DashboardView = (typeof DASHBOARD_VIEWS)[number]['id']
export type DeskNavId = DashboardView | 'terminal'

export const TERMINAL_NAV = {
  id: 'terminal' as const,
  label: 'Live Terminal',
  href: '/dashboard/terminal',
  icon: CandlestickChart,
}
