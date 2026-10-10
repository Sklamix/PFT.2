'use client'

import { useState } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { TRADES, formatUsd, type Trade, type TradingAccount } from '@/lib/dashboard-data'
import { cn } from '@/lib/utils'

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'wins', label: 'Winners' },
  { id: 'losses', label: 'Losers' },
] as const

type Filter = (typeof FILTERS)[number]['id']

function priceDigits(asset: string) {
  if (asset.includes('JPY')) return 3
  if (asset === 'XAU/USD') return 2
  if (asset === 'NAS100') return 1
  return 5
}

export function TradesLedger({ account, limit, title = 'Recent Executed Trades' }: { account: TradingAccount; limit?: number; title?: string }) {
  const [filter, setFilter] = useState<Filter>('all')
  const trades = (TRADES[account.id] ?? []).filter((trade) => (filter === 'all' ? true : filter === 'wins' ? trade.net >= 0 : trade.net < 0))
  const visible = limit ? trades.slice(0, limit) : trades

  return (
    <section aria-labelledby="ledger-title" className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id="ledger-title" className="text-base font-semibold text-foreground">{title}</h2>
          <p className="text-sm text-muted-foreground">Closed positions on {account.id}</p>
        </div>
        <div className="flex rounded-lg border border-border bg-background p-0.5" role="group" aria-label="Filter trades">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
              className={cn(
                'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                filter === item.id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      <Table className="font-mono text-xs">
        <TableHeader>
          <TableRow className="border-border hover:bg-transparent">
            <TableHead className="text-muted-foreground">Asset</TableHead>
            <TableHead className="text-muted-foreground">Side</TableHead>
            <TableHead className="text-right text-muted-foreground">Open</TableHead>
            <TableHead className="text-right text-muted-foreground">Close</TableHead>
            <TableHead className="text-right text-muted-foreground">Lots</TableHead>
            <TableHead className="hidden text-right text-muted-foreground md:table-cell">Comm.</TableHead>
            <TableHead className="text-right text-muted-foreground">Net P/L</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((trade) => (
            <TradeRow key={trade.id} trade={trade} />
          ))}
          {visible.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                No trades match this filter.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </section>
  )
}

function TradeRow({ trade }: { trade: Trade }) {
  const digits = priceDigits(trade.asset)
  const format = (value: number) => value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return (
    <TableRow className="border-border">
      <TableCell>
        <span className="block font-semibold text-foreground">{trade.asset}</span>
        <span className="block text-[10px] text-muted-foreground">{trade.closedAt}</span>
      </TableCell>
      <TableCell>
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wider',
            trade.direction === 'BUY' ? 'bg-primary/15 text-primary' : 'bg-danger/15 text-danger',
          )}
        >
          {trade.direction}
        </span>
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">{format(trade.open)}</TableCell>
      <TableCell className="text-right tabular-nums text-foreground">{format(trade.close)}</TableCell>
      <TableCell className="text-right tabular-nums text-foreground">{trade.lots.toFixed(2)}</TableCell>
      <TableCell className="hidden text-right tabular-nums text-muted-foreground md:table-cell">{formatUsd(trade.commission)}</TableCell>
      <TableCell className={cn('text-right font-semibold tabular-nums', trade.net >= 0 ? 'text-primary' : 'text-danger')}>
        {formatUsd(trade.net, { signed: true })}
      </TableCell>
    </TableRow>
  )
}
