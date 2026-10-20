'use client'

import { useEffect, useState } from 'react'
import { LogOut, Plus, X } from 'lucide-react'
import { ChallengeCalculator } from '@/components/challenge-calculator'
import { useMarketData } from '@/hooks/useMarketData'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { redirectToLogin, useTerminalBook } from '@/lib/stores/useTerminalBook'
import { useTradingStore } from '@/lib/stores/useTradingStore'
import { cn } from '@/lib/utils'
import { OrderPanel } from './OrderPanel'
import { PositionsTable } from './PositionsTable'
import { TerminalHeader } from './TerminalHeader'
import { TradingChart } from './TradingChart'

const RISK_SYNC_MS = 2000

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
  const [challengeDialogOpen, setChallengeDialogOpen] = useState(false)
  const accountId = useTerminalBook((state) => state.accountId)
  const hasNoAccounts = loadState === 'error' && loadError === 'No trading accounts on this login yet'

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const response = await fetch('/api/auth/me', { cache: 'no-store' }).catch(() => null)
      if (response?.status === 401) return redirectToLogin()
      const data = (await response?.json().catch(() => null)) as TraderMe | null
      if (cancelled) return
      if (!response?.ok || !data?.accounts) {
        useTerminalBook.setState({ loadState: 'error', loadError: 'Unable to load your accounts' })
        return
      }
      setTrader(data)
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
    })()
    return () => {
      cancelled = true
    }
  }, [init])

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
          onNewChallenge={() => setChallengeDialogOpen(true)}
        />
      )}
      {hasNoAccounts ? (
        <NoAccountsState onNewChallenge={() => setChallengeDialogOpen(true)} />
      ) : (
        <>
          <TerminalHeader />
          <NoticeBar />
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 lg:flex-row">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
              <TradingChart />
              <PositionsTable />
            </div>
            <OrderPanel />
          </div>
        </>
      )}
      {trader && (
        <Dialog open={challengeDialogOpen} onOpenChange={setChallengeDialogOpen}>
          <DialogContent
            overlayClassName="z-[70] bg-background/80 backdrop-blur-sm"
            className="z-[70] max-h-[92dvh] w-[calc(100%-1rem)] max-w-6xl gap-0 overflow-y-auto border-border bg-background p-3 sm:w-[calc(100%-2rem)] sm:p-5"
          >
            <div className="mb-3 pr-9">
              <DialogTitle className="text-lg font-semibold">Choose a new challenge</DialogTitle>
              <DialogDescription className="mt-1 text-sm text-muted-foreground">
                Select your account size and rules. Your purchase will be linked to {trader.trader.email}.
              </DialogDescription>
            </div>
            <ChallengeCalculator
              presentation="dialog"
              customer={{ email: trader.trader.email, name: trader.trader.name }}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

function NoAccountsState({ onNewChallenge }: { onNewChallenge: () => void }) {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <section className="w-full max-w-lg rounded-2xl border border-border bg-card p-8 text-center shadow-xl">
        <p className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-primary">Trader workspace</p>
        <h1 className="mt-3 text-2xl font-semibold text-foreground">No challenge accounts yet</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          No trading accounts are linked to this login yet. Choose a challenge to create your own account.
          The accounts shown in the old dashboard were examples only and cannot be used to trade.
        </p>
        <button
          type="button"
          onClick={onNewChallenge}
          className="mt-6 inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-linear-to-r from-primary via-highlight to-primary bg-size-[200%_100%] bg-left px-5 text-sm font-semibold text-primary-foreground shadow-[0_0_28px_-12px] shadow-primary transition-[background-position,box-shadow] duration-300 hover:bg-right hover:shadow-[0_0_36px_-10px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Plus className="size-4" aria-hidden="true" />
          New Challenge
        </button>
      </section>
    </main>
  )
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
  onNewChallenge,
}: {
  trader: TraderMe
  accountId: string
  onNewChallenge: () => void
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
        onClick={onNewChallenge}
        className="group inline-flex h-8 items-center gap-1.5 rounded-md bg-linear-to-r from-primary via-highlight to-primary bg-size-[200%_100%] bg-left px-3 text-xs font-semibold text-primary-foreground shadow-[0_0_20px_-10px] shadow-primary transition-[background-position,box-shadow] duration-300 hover:bg-right hover:shadow-[0_0_28px_-8px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Plus className="size-3.5 transition-transform group-hover:rotate-90" aria-hidden="true" />
        New Challenge
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

  if (loadState === 'error') {
    return <Banner tone="danger" message={`Trading account unavailable: ${loadError ?? 'unknown error'}`} />
  }

  return (
    <>
      {account && account.status !== 'ACTIVE' ? (
        <Banner
          tone="danger"
          message={`Account ${account.id} is ${account.status}${account.breachReason ? ` — ${account.breachReason}` : ''}. Trading is disabled.`}
          action={
            account.activeSiblingAccountId ? (
              <Button size="sm" variant="outline" onClick={() => switchAccount(account.activeSiblingAccountId!)}>
                Switch to {account.activeSiblingAccountId}
              </Button>
            ) : null
          }
        />
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
