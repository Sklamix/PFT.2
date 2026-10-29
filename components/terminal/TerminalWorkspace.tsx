'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Loader2, LogOut, Plus, RefreshCw, Rocket, X, XCircle } from 'lucide-react'
import { ChallengeCalculator } from '@/components/challenge-calculator'
import { useMarketData } from '@/hooks/useMarketData'
import { Button } from '@/components/ui/button'
import { PFTMessageCard } from '@/components/messages/PFTMessageCard'
import { formatPrice } from '@/lib/challenges'
import { redirectToLogin, useTerminalBook } from '@/lib/stores/useTerminalBook'
import { loadStoredFavorites } from '@/lib/stores/useFavoritesStore'
import { loadStoredTimeZone } from '@/lib/stores/useTimezoneStore'
import { useTradingStore } from '@/lib/stores/useTradingStore'
import { cn } from '@/lib/utils'
import { AppealDialog } from './AppealDialog'
import { EconomicCalendarPanel } from './EconomicCalendarPanel'
import { OrderPanel } from './OrderPanel'
import { PositionsTable } from './PositionsTable'
import { ResetAccountDialog } from './ResetAccountDialog'
import { TerminalHeader } from './TerminalHeader'
import { TradingChart } from './TradingChart'

const RISK_SYNC_MS = 2000
const ORDER_POLL_MS = 10_000

type CheckoutOrder = {
  id: string
  status: 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED' | 'REFUNDED'
  amount: number
  createdAt: string
  planSize: number | null
  evaluationLabel: string | null
  paymentUrl: string | null
}

function switchAccount(accountId: string) {
  const url = new URL(window.location.href)
  url.searchParams.set('account', accountId)
  window.history.replaceState(null, '', url)
  void useTerminalBook.getState().init(accountId)
}

export function TerminalWorkspace() {
  useMarketData()
  const selectedSymbol = useTradingStore((state) => state.selectedSymbol)
  const bid = useTradingStore((state) => state.bid)
  const ask = useTradingStore((state) => state.ask)
  const currentPrice = useTradingStore((state) => state.currentPrice)
  const connectionStatus = useTradingStore((state) => state.connectionStatus)
  const markMarket = useTerminalBook((state) => state.markMarket)
  const init = useTerminalBook((state) => state.init)
  const sync = useTerminalBook((state) => state.sync)
  const accountStatus = useTerminalBook((state) => state.account?.status)
  const loadState = useTerminalBook((state) => state.loadState)
  const loadError = useTerminalBook((state) => state.loadError)
  const openCount = useTerminalBook((state) => state.positions.length)
  const pendingCount = useTerminalBook((state) => state.pending.length)

  const [trader, setTrader] = useState<TraderMe | null>(null)
  const [orders, setOrders] = useState<CheckoutOrder[] | null>(null)
  const [activatedAccount, setActivatedAccount] = useState<{ id: string; displayId: string } | null>(null)
  const knownAccountIds = useRef<string[] | null>(null)
  const [challengeViewOpen, setChallengeViewOpen] = useState(false)
  const accountId = useTerminalBook((state) => state.accountId)
  const hasNoAccounts = loadState === 'error' && loadError === 'No trading accounts on this login yet'

  useEffect(() => {
    loadStoredTimeZone()
    void loadStoredFavorites()
  }, [])

  const loadOrders = useCallback(async () => {
    const response = await fetch('/api/checkout/pending', { cache: 'no-store' }).catch(() => null)
    if (!response?.ok) return
    const data = (await response.json().catch(() => null)) as { orders?: CheckoutOrder[] } | null
    if (Array.isArray(data?.orders)) setOrders(data!.orders)
  }, [])

  const loadTrader = useCallback(async (mode: 'initial' | 'refresh' = 'initial') => {
    const response = await fetch('/api/auth/me', { cache: 'no-store' }).catch(() => null)
    if (response?.status === 401) return redirectToLogin()
    const data = (await response?.json().catch(() => null)) as TraderMe | null
    if (!response?.ok || !data?.accounts) {
      useTerminalBook.setState({ loadState: 'error', loadError: 'Unable to load your accounts' })
      return
    }
    setTrader(data)
    // A background refresh must never re-init an account the trader is actively using.
    const activeId = useTerminalBook.getState().accountId
    if (mode === 'refresh' && activeId && data.accounts.some((account) => account.id === activeId)) return
    const requested = new URLSearchParams(window.location.search).get('account')?.trim()
    const target =
      data.accounts.find((account) => account.id === requested) ??
      data.accounts.find((account) => account.status === 'ACTIVE') ??
      data.accounts[0]
    if (!target) {
      useTerminalBook.setState({ loadState: 'error', loadError: 'No trading accounts on this login yet' })
      return
    }
    if (target.id !== requested) switchAccount(target.id)
    else void init(target.id)
  }, [init])

  useEffect(() => {
    void loadTrader().then(loadOrders)
  }, [loadTrader, loadOrders])

  const pendingOrders = (orders ?? []).filter((order) => order.status === 'PENDING' || order.status === 'PAID')
  const failedOrders = (orders ?? []).filter((order) => order.status === 'FAILED' || order.status === 'EXPIRED')

  // Keep polling while a payment is confirming — even when the trader already has other accounts.
  useEffect(() => {
    if (!hasNoAccounts && pendingOrders.length === 0) return
    const timer = setInterval(() => {
      void loadTrader('refresh').then(loadOrders)
    }, ORDER_POLL_MS)
    return () => clearInterval(timer)
  }, [hasNoAccounts, pendingOrders.length, loadTrader, loadOrders])

  // Announce an account that appeared while the trader already had others (no forced switch).
  useEffect(() => {
    const accounts = trader?.accounts
    if (!accounts) return
    const previous = knownAccountIds.current
    knownAccountIds.current = accounts.map((account) => account.id)
    if (!previous || previous.length === 0) return
    const added = accounts.find((account) => !previous.includes(account.id))
    if (added) setActivatedAccount({ id: added.id, displayId: added.displayId })
  }, [trader])

  useEffect(() => {
    if (connectionStatus !== 'CONNECTED') return
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || !Number.isFinite(currentPrice)) return
    markMarket(selectedSymbol, bid, ask, currentPrice)
  }, [ask, bid, connectionStatus, currentPrice, markMarket, selectedSymbol])

  useEffect(() => {
    if (accountStatus !== 'ACTIVE' || (openCount === 0 && pendingCount === 0)) return
    const timer = setInterval(() => void sync(), RISK_SYNC_MS)
    return () => clearInterval(timer)
  }, [accountStatus, openCount, pendingCount, sync])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {trader && (
        <AccountBar
          trader={trader}
          accountId={accountId}
          challengeViewOpen={challengeViewOpen}
          onNewChallenge={() => setChallengeViewOpen(true)}
          onBackToTerminal={() => setChallengeViewOpen(false)}
        />
      )}
      {challengeViewOpen && trader ? (
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto flex min-h-full max-w-[1600px] animate-step-in flex-col justify-center px-3 py-5 sm:px-6 lg:px-8">
            <header className="mx-auto mb-3 w-full max-w-7xl px-4 sm:px-6 lg:px-8">
              <p className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-primary">Trader workspace</p>
              <h1 className="mt-2 text-2xl font-semibold text-foreground">Choose your next challenge</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Configure your account and complete checkout here. The new account will be linked to {trader.trader.email}.
              </p>
            </header>
            <ChallengeCalculator
              presentation="embedded"
              customer={{ email: trader.trader.email, name: trader.trader.name }}
            />
          </div>
        </main>
      ) : hasNoAccounts && pendingOrders.length > 0 ? (
        <PaymentProcessingState orders={pendingOrders} onRefresh={() => void loadOrders()} />
      ) : hasNoAccounts && failedOrders.length > 0 ? (
        <PaymentFailedState orders={failedOrders} onNewChallenge={() => setChallengeViewOpen(true)} />
      ) : hasNoAccounts ? (
        <NoAccountsState onNewChallenge={() => setChallengeViewOpen(true)} />
      ) : (
        <>
          <TerminalHeader />
          <NoticeBar />
          {pendingOrders.length > 0 && (
            <Banner
              tone="info"
              message="New challenge is processing — the account will appear in the selector automatically once the payment confirms."
            />
          )}
          {activatedAccount && (
            <Banner
              tone="success"
              message={`Account ${activatedAccount.displayId} is ready.`}
              onDismiss={() => setActivatedAccount(null)}
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    switchAccount(activatedAccount.id)
                    setActivatedAccount(null)
                  }}
                >
                  Open account
                </Button>
              }
            />
          )}
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 lg:flex-row">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
              <TradingChart />
              <PositionsTable />
              <EconomicCalendarPanel />
            </div>
            <OrderPanel />
          </div>
        </>
      )}
    </div>
  )
}

function NoAccountsState({ onNewChallenge }: { onNewChallenge: () => void }) {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <PFTMessageCard
        tone="info"
        icon={<Rocket className="size-6" />}
        eyebrow="Trader workspace"
        title="No challenge accounts yet"
        description="No trading accounts are linked to this login yet. Choose a challenge to create your own account. The accounts shown in the old dashboard were examples only and cannot be used to trade."
        actions={
          <button
            type="button"
            onClick={onNewChallenge}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-linear-to-r from-primary via-highlight to-primary bg-size-[200%_100%] bg-left px-5 text-sm font-semibold text-primary-foreground shadow-[0_0_28px_-12px] shadow-primary transition-[background-position,box-shadow] duration-300 hover:bg-right hover:shadow-[0_0_36px_-10px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Plus className="size-4" aria-hidden="true" />
            New Challenge
          </button>
        }
      />
    </main>
  )
}

function PaymentProcessingState({ orders, onRefresh }: { orders: CheckoutOrder[]; onRefresh: () => void }) {
  const latest = orders[0]
  const latestOrderDate = formatDate(new Date(latest.createdAt))

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <PFTMessageCard
        tone="pending"
        icon={<Loader2 className="size-6 motion-safe:animate-spin" />}
        eyebrow="Payment processing"
        title="Your challenge is being set up"
        description="We are confirming your payment and provisioning the account. Your PFT terminal credentials are emailed the moment it completes — the account will appear in this workspace automatically."
        details={[
          ['Plan', latest?.planSize ? `${Math.round(latest.planSize / 1000)}k${latest.evaluationLabel ? ` · ${latest.evaluationLabel}` : ''}` : '—'],
          ['Total', latest ? `${formatPrice(latest.amount)} USD` : '—'],
          ...(latest ? [['Order', latestOrderDate] as [string, string]] : []),
        ]}
        actions={
          <>
            {latest.paymentUrl ? (
              <a
                href={latest.paymentUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-linear-to-r from-primary via-highlight to-primary bg-size-[200%_100%] bg-left px-5 text-sm font-semibold text-primary-foreground shadow-[0_0_28px_-12px] shadow-primary transition-[background-position,box-shadow] duration-300 hover:bg-right hover:shadow-[0_0_36px_-10px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                Return to payment
              </a>
            ) : null}
            <Button variant="outline" size="sm" className="gap-1.5" onClick={onRefresh} aria-label="Check payment status now">
              <RefreshCw className="size-3.5" aria-hidden="true" />
              Check status now
            </Button>
            <p className="text-xs text-slate-500">Status refreshes automatically every 10 seconds.</p>
          </>
        }
      />
    </main>
  )
}

function PaymentFailedState({ orders, onNewChallenge }: { orders: CheckoutOrder[]; onNewChallenge: () => void }) {
  const latest = orders[0]
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <PFTMessageCard
        tone="error"
        icon={<XCircle className="size-6" />}
        eyebrow="Checkout incomplete"
        title="Your payment was not completed"
        description={`Your last order${latest?.planSize ? `, ${Math.round(latest.planSize / 1000)}k ${latest?.evaluationLabel ?? ''},` : ''} expired or failed before the transfer confirmed — you were not charged for a challenge account. Start a new checkout to try again.`}
        actions={
          <>
            {latest.paymentUrl ? (
              <a
                href={latest.paymentUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-slate-700 px-4 text-sm font-medium text-slate-200 transition hover:border-slate-500"
              >
                Return to payment
              </a>
            ) : null}
            <button
              type="button"
              onClick={onNewChallenge}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-linear-to-r from-primary via-highlight to-primary bg-size-[200%_100%] bg-left px-5 text-sm font-semibold text-primary-foreground shadow-[0_0_28px_-12px] shadow-primary transition-[background-position,box-shadow] duration-300 hover:bg-right hover:shadow-[0_0_36px_-10px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <Plus className="size-4" aria-hidden="true" />
              New Challenge
            </button>
          </>
        }
      />
    </main>
  )
}

function formatDate(value: Date) {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(value)
}

interface TraderMe {
  trader: { sub: string; email: string; name: string }
  accounts: { id: string; displayId: string; status: string; planSize: number }[]
}

async function signOut() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => null)
  window.location.assign('/login')
}

function AccountBar({
  trader,
  accountId,
  challengeViewOpen,
  onNewChallenge,
  onBackToTerminal,
}: {
  trader: TraderMe
  accountId: string
  challengeViewOpen: boolean
  onNewChallenge: () => void
  onBackToTerminal: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card/60 px-3 py-1.5 text-xs lg:px-4">
      {trader.accounts.length > 0 ? (
        <label className="flex items-center gap-2 text-muted-foreground">
          Account
          <select
            value={accountId}
            onChange={(event) => switchAccount(event.target.value)}
            className="h-7 rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground"
          >
            {trader.accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.displayId} · {account.status.replace(/_/g, ' ').toLowerCase()}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <span className="text-muted-foreground">No linked trading accounts</span>
      )}
      <span className="ml-auto truncate text-muted-foreground">{trader.trader.email}</span>
      <button
        type="button"
        onClick={challengeViewOpen ? onBackToTerminal : onNewChallenge}
        className="group inline-flex h-8 items-center gap-1.5 rounded-md bg-linear-to-r from-primary via-highlight to-primary bg-size-[200%_100%] bg-left px-3 text-xs font-semibold text-primary-foreground shadow-[0_0_20px_-10px] shadow-primary transition-[background-position,box-shadow] duration-300 hover:bg-right hover:shadow-[0_0_28px_-8px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {challengeViewOpen
          ? <ArrowLeft className="size-3.5" aria-hidden="true" />
          : <Plus className="size-3.5 transition-transform group-hover:rotate-90" aria-hidden="true" />}
        {challengeViewOpen ? 'Back to terminal' : 'New Challenge'}
      </button>
      <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs" onClick={() => void signOut()}>
        <LogOut className="size-3.5" aria-hidden="true" />
        Sign out
      </Button>
    </div>
  )
}

function NoticeBar() {
  const notice = useTerminalBook((state) => state.notice)
  const loadState = useTerminalBook((state) => state.loadState)
  const loadError = useTerminalBook((state) => state.loadError)
  const account = useTerminalBook((state) => state.account)
  const dismiss = useTerminalBook((state) => state.dismissNotice)
  const [appealOpen, setAppealOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)

  if (loadState === 'error') {
    return <Banner tone="danger" message={`Trading account unavailable: ${loadError ?? 'unknown error'}`} />
  }

  const breached = account && (account.status === 'BREACHED' || account.status === 'BREACHED_DAILY' || account.status === 'BREACHED_MAX')
  // FUNDED accounts trade normally; only non-trading statuses get the banner.
  const tradingDisabled = account && account.status !== 'ACTIVE' && account.status !== 'FUNDED'

  return (
    <>
      {account && tradingDisabled ? (
        <Banner
          tone="danger"
          message={`Account ${account.id} is ${account.status}${account.breachReason ? ` — ${account.breachReason}` : ''}. Trading is disabled.`}
          action={
            <div className="flex flex-wrap items-center gap-2">
              {account.activeSiblingAccountId ? (
                <Button size="sm" variant="outline" onClick={() => switchAccount(account.activeSiblingAccountId!)}>
                  Switch to {account.activeSiblingAccountId}
                </Button>
              ) : null}
              {breached ? (
                <>
                  <Button size="sm" variant="outline" onClick={() => setResetOpen(true)}>
                    Reset account
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setAppealOpen(true)}>
                    Appeal decision
                  </Button>
                </>
              ) : null}
            </div>
          }
        />
      ) : null}
      {breached ? (
        <AppealDialog accountId={account.id} open={appealOpen} onOpenChange={setAppealOpen} />
      ) : null}
      {breached ? (
        <ResetAccountDialog accountId={account.id} open={resetOpen} onOpenChange={setResetOpen} />
      ) : null}
      {notice ? (
        <Banner
          tone={notice.tone}
          message={notice.message}
          onDismiss={dismiss}
          action={
            notice.switchToAccountId && notice.switchToAccountId !== account?.activeSiblingAccountId ? (
              <Button size="sm" variant="outline" onClick={() => switchAccount(notice.switchToAccountId!)}>
                Switch to standby account
              </Button>
            ) : null
          }
        />
      ) : null}
    </>
  )
}

function Banner({
  tone,
  message,
  action,
  onDismiss,
}: {
  tone: 'info' | 'success' | 'danger'
  message: string
  action?: React.ReactNode
  onDismiss?: () => void
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'mx-3 mt-3 flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-xs',
        tone === 'danger' && 'border-danger/40 bg-danger/10 text-danger',
        tone === 'success' && 'border-primary/40 bg-primary/10 text-primary',
        tone === 'info' && 'border-border bg-secondary/60 text-foreground',
      )}
    >
      <p className="min-w-0 flex-1">{message}</p>
      {action}
      {onDismiss ? (
        <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={onDismiss}>
          <X className="size-3.5" />
        </Button>
      ) : null}
    </div>
  )
}
