'use client'

import { useEffect, useState } from 'react'
import { LogOut, X } from 'lucide-react'
import { useMarketData } from '@/hooks/useMarketData'
import { Button } from '@/components/ui/button'
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
  const openCount = useTerminalBook((state) => state.positions.length)

  const [trader, setTrader] = useState<TraderMe | null>(null)
  const accountId = useTerminalBook((state) => state.accountId)

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
    if (accountStatus !== 'ACTIVE' || openCount === 0) return
    const timer = setInterval(() => void sync(), RISK_SYNC_MS)
    return () => clearInterval(timer)
  }, [accountStatus, openCount, sync])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {trader && <AccountBar trader={trader} accountId={accountId} />}
      <TerminalHeader />
      <NoticeBar />
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          <TradingChart />
          <PositionsTable />
        </div>
        <OrderPanel />
      </div>
    </div>
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

function AccountBar({ trader, accountId }: { trader: TraderMe; accountId: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card/60 px-3 py-1.5 text-xs lg:px-4">
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
      <span className="ml-auto truncate text-muted-foreground">{trader.trader.email}</span>
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
