'use client'

import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useMarketData } from '@/hooks/useMarketData'
import { Button } from '@/components/ui/button'
import { DEFAULT_ACCOUNT_ID, useTerminalBook } from '@/lib/stores/useTerminalBook'
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

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('account')?.trim()
    void init(requested || DEFAULT_ACCOUNT_ID)
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
        />
      ) : null}
      {notice ? (
        <Banner
          tone={notice.tone}
          message={notice.message}
          onDismiss={dismiss}
          action={
            notice.switchToAccountId ? (
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
