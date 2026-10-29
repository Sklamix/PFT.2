'use client'

import { useState } from 'react'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { getAccount } from '@/lib/dashboard-data'
import { CredentialsDialog } from './credentials-dialog'
import { EquityCurve } from './equity-curve'
import { MetricCards } from './metric-cards'
import { DASHBOARD_VIEWS, type DashboardView } from './nav-config'
import { ObjectivesChecklist } from './objectives-checklist'
import { PayoutCard } from './payout-card'
import { PayoutRequestDialog } from './payout-request-dialog'
import { AccountsView, BillingView, JournalView, PayoutsView, SettingsView, ViewHeading } from './secondary-views'
import { SidebarContent } from './sidebar'
import { StatusBanner } from './status-banner'
import { TopBar } from './top-bar'
import { TradesLedger } from './trades-ledger'

const VIEW_DESCRIPTIONS: Record<DashboardView, string> = {
  overview: 'Live guardrails, objectives and execution for the active account.',
  accounts: 'All evaluation and funded accounts linked to your profile.',
  payouts: 'Weekly disbursements, revenue share and official certificates.',
  journal: 'Every closed position with performance statistics.',
  calendar: 'Track high-impact economic releases and news-window risk.',
  billing: 'Challenge orders, invoices and payment history.',
  settings: 'Identity verification, security and notification preferences.',
}

export function DashboardShell() {
  const [accountId, setAccountId] = useState('PFT-100K-98214')
  const [view, setView] = useState<DashboardView>('overview')
  const [menuOpen, setMenuOpen] = useState(false)
  const [credentialsOpen, setCredentialsOpen] = useState(false)
  const [payoutOpen, setPayoutOpen] = useState(false)
  const account = getAccount(accountId)
  const viewLabel = DASHBOARD_VIEWS.find((item) => item.id === view)?.label ?? ''

  function navigate(next: DashboardView) {
    setView(next)
    setMenuOpen(false)
  }

  return (
    <div className="min-h-dvh bg-background lg:pl-64">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r border-border bg-sidebar lg:block">
        <SidebarContent view={view} onNavigate={navigate} />
      </aside>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-72 border-border bg-sidebar p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Dashboard sections</SheetDescription>
          <SidebarContent view={view} onNavigate={navigate} />
        </SheetContent>
      </Sheet>

      <TopBar
        account={account}
        onAccountChange={setAccountId}
        onOpenMenu={() => setMenuOpen(true)}
        onOpenCredentials={() => setCredentialsOpen(true)}
        onRequestPayout={() => setPayoutOpen(true)}
      />

      <main className="mx-auto flex max-w-[1600px] flex-col gap-4 p-4 lg:gap-5 lg:p-6">
        <ViewHeading title={viewLabel} description={VIEW_DESCRIPTIONS[view]} />

        {view === 'overview' && (
          <>
            <StatusBanner account={account} onShowCredentials={() => setCredentialsOpen(true)} />
            <MetricCards account={account} />
            <div className="grid gap-4 lg:gap-5 xl:grid-cols-3">
              <div className="min-w-0 xl:col-span-2">
                <EquityCurve account={account} />
              </div>
              <ObjectivesChecklist account={account} />
            </div>
            <div className="grid gap-4 lg:gap-5 xl:grid-cols-3">
              <div className="min-w-0 xl:col-span-2">
                <TradesLedger account={account} limit={6} />
              </div>
              <PayoutCard account={account} onRequestPayout={() => setPayoutOpen(true)} />
            </div>
          </>
        )}
        {view === 'accounts' && (
          <AccountsView
            activeId={accountId}
            onSelect={(id) => {
              setAccountId(id)
              setView('overview')
            }}
          />
        )}
        {view === 'payouts' && <PayoutsView account={account} onRequestPayout={() => setPayoutOpen(true)} />}
        {view === 'journal' && <JournalView account={account} />}
        {view === 'billing' && <BillingView />}
        {view === 'settings' && <SettingsView />}
      </main>

      <CredentialsDialog account={account} open={credentialsOpen} onOpenChange={setCredentialsOpen} />
      <PayoutRequestDialog account={account} open={payoutOpen} onOpenChange={setPayoutOpen} />
    </div>
  )
}
