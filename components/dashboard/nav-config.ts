import { Award, BookOpen, CandlestickChart, Layers, LayoutDashboard, Receipt, ShieldCheck } from 'lucide-react'

export const DASHBOARD_VIEWS = [
  { id: 'overview', label: 'Overview / Cockpit', icon: LayoutDashboard, href: '/dashboard/overview' },
  { id: 'accounts', label: 'Trading Accounts', icon: Layers },
  { id: 'payouts', label: 'Payouts & Certificates', icon: Award },
  { id: 'journal', label: 'Trading Journal', icon: BookOpen },
  { id: 'billing', label: 'Billing & Orders', icon: Receipt },
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
