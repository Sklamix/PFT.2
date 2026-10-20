'use client'

import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { FOREX_MAJORS, formatPrice, formatSpreadPips, getSymbol } from '@/lib/constants/symbols'
import { formatPct, formatUsd } from '@/lib/dashboard-data'
import { useTerminalBook } from '@/lib/stores/useTerminalBook'
import { useTradingStore } from '@/lib/stores/useTradingStore'
import { cn } from '@/lib/utils'

export function TerminalHeader() {
  const selectedSymbol = useTradingStore((state) => state.selectedSymbol)
  const setSelectedSymbol = useTradingStore((state) => state.setSelectedSymbol)
  const bid = useTradingStore((state) => state.bid)
  const ask = useTradingStore((state) => state.ask)
  const spread = useTradingStore((state) => state.spread)
  const change = useTradingStore((state) => state.priceChangePercent24h)
  const connectionStatus = useTradingStore((state) => state.connectionStatus)
  const feedMode = useTradingStore((state) => state.feedMode)
  const snapshot = useTerminalBook((state) => state.snapshot)
  const account = useTerminalBook((state) => state.account)
  const meta = getSymbol(selectedSymbol)
  const live = connectionStatus === 'CONNECTED' && feedMode === 'LIVE'
  const up = change >= 0
  const ddRatio = snapshot.dailyUsedRatio

  return (
    <header className="flex flex-col gap-3 border-b border-border bg-card/80 px-3 py-2.5 backdrop-blur-md lg:flex-row lg:items-center lg:gap-4 lg:px-4">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" className="h-9 min-w-40 justify-between gap-2 font-mono" />}>
            <span className="flex flex-col items-start leading-none">
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Symbol</span>
              <span className="mt-0.5 text-sm text-foreground">{meta.displayName}</span>
            </span>
            <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Forex majors</DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={String(selectedSymbol)} onValueChange={setSelectedSymbol}>
              {FOREX_MAJORS.map((id) => {
                const item = getSymbol(id)
                return (
                  <DropdownMenuRadioItem key={id} value={id} className="font-mono">
                    <span className="flex w-full items-center justify-between gap-4">
                      <span>{item.displayName}</span>
                      <span className="text-[10px] text-muted-foreground">{item.name}</span>
                    </span>
                  </DropdownMenuRadioItem>
                )
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex min-w-0 items-center gap-3 font-mono">
          <QuoteStack label="Bid" value={formatPrice(selectedSymbol, bid)} tone="danger" />
          <QuoteStack label="Ask" value={formatPrice(selectedSymbol, ask)} tone="primary" />
          <div className="hidden sm:block">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Spread</p>
            <p className="text-sm tabular-nums text-foreground">{formatSpreadPips(selectedSymbol, spread)} pips</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">24h</p>
            <p className={cn('text-sm tabular-nums', up ? 'text-primary' : 'text-danger')}>{formatPct(change, true)}</p>
          </div>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider',
              live
                ? 'border-primary/30 bg-primary/10 text-primary'
                : 'border-danger/30 bg-danger/10 text-danger',
            )}
          >
            <span
              className={cn('size-1.5 rounded-full', live ? 'bg-primary' : 'bg-danger')}
              aria-hidden="true"
            />
            {live ? 'Live · indicative spread' : connectionStatus.toLowerCase()}
          </span>
        </div>
      </div>

      <dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4 lg:flex lg:items-center lg:justify-end lg:gap-5">
        <Metric
          label="Account"
          value={account ? account.status : '—'}
          accent={account?.status === 'ACTIVE' ? 'text-primary' : account ? 'text-danger' : undefined}
        />
        <Metric label="Balance" value={formatUsd(snapshot.balance)} />
        <Metric label="Equity" value={formatUsd(snapshot.equity)} accent={snapshot.floatingPnl >= 0 ? 'text-primary' : 'text-danger'} />
        <Metric label="Margin used" value={formatUsd(snapshot.marginUsed)} />
        <Metric label="Free margin" value={formatUsd(snapshot.freeMargin)} />
        <div className="col-span-2 min-w-40 sm:col-span-4 lg:w-52">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-muted-foreground">
            <span>Daily DD buffer</span>
            <span className="font-mono tabular-nums text-foreground">{formatUsd(snapshot.dailyBufferUsd)}</span>
          </div>
          <div
            className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary"
            role="meter"
            aria-label="Daily drawdown buffer remaining"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((1 - ddRatio) * 100)}
          >
            <div
              className={cn(
                'h-full rounded-full transition-[width]',
                ddRatio >= 0.8 ? 'bg-danger' : ddRatio >= 0.5 ? 'bg-warning' : 'bg-primary',
              )}
              style={{ width: `${Math.max(4, (1 - ddRatio) * 100)}%` }}
            />
          </div>
        </div>
      </dl>
    </header>
  )
}

function QuoteStack({ label, value, tone }: { label: string; value: string; tone: 'primary' | 'danger' }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className={cn('text-sm font-semibold tabular-nums', tone === 'primary' ? 'text-primary' : 'text-danger')}>{value}</p>
    </div>
  )
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</dt>
      <dd className={cn('truncate font-mono text-sm tabular-nums text-foreground', accent)}>{value}</dd>
    </div>
  )
}
