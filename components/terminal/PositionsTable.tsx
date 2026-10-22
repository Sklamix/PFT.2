'use client'

import { useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatPrice, getSymbol } from '@/lib/constants/symbols'
import { formatPct, formatUsd } from '@/lib/dashboard-data'
import { useTerminalBook } from '@/lib/stores/useTerminalBook'
import { useTimezoneStore } from '@/lib/stores/useTimezoneStore'
import type { CloseReason, OrderSide } from '@/lib/types/terminal'
import { cn } from '@/lib/utils'

const CLOSE_LABEL: Record<CloseReason, string> = {
  TAKE_PROFIT: 'Take profit',
  STOP_LOSS: 'Stop loss',
  MANUAL: 'Manual',
  LIQUIDATION_BREACH: 'Liquidation',
}

export function PositionsTable() {
  const positions = useTerminalBook((state) => state.positions)
  const history = useTerminalBook((state) => state.history)
  const pending = useTerminalBook((state) => state.pending)
  const snapshot = useTerminalBook((state) => state.snapshot)
  const closePosition = useTerminalBook((state) => state.closePosition)
  const cancelPending = useTerminalBook((state) => state.cancelPending)
  const closing = useTerminalBook((state) => state.closing)
  const cancelling = useTerminalBook((state) => state.cancelling)
  const timeZone = useTimezoneStore((state) => state.timeZone)
  const [closeError, setCloseError] = useState<string | null>(null)

  async function close(id: string) {
    setCloseError(null)
    const result = await closePosition(id)
    if (!result.ok) setCloseError(result.error)
  }

  async function cancel(id: string) {
    setCloseError(null)
    const result = await cancelPending(id)
    if (!result.ok) setCloseError(result.error)
  }

  return (
    <section className="rounded-xl border border-border bg-card">
      <Tabs defaultValue="positions">
        <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
          <TabsList>
            <TabsTrigger value="positions">Open positions</TabsTrigger>
            <TabsTrigger value="history">Trade history</TabsTrigger>
            <TabsTrigger value="rules">Rules monitor</TabsTrigger>
          </TabsList>
          <p className="hidden font-mono text-[10px] uppercase tracking-widest text-muted-foreground sm:block">
            {positions.length} open · {pending.length} working
          </p>
        </div>

        <TabsContent value="positions" className="p-0">
          {closeError ? (
            <p role="alert" className="border-b border-border px-4 py-2 font-mono text-[11px] text-danger">
              {closeError}
            </p>
          ) : null}
          {positions.length === 0 && pending.length === 0 ? (
            <Empty message="No open positions. Use the ticket on the right to send a market or limit order." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Symbol</TableHead>
                  <TableHead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Time</TableHead>
                  <TableHead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Side</TableHead>
                  <TableHead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Lots</TableHead>
                  <TableHead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Entry</TableHead>
                  <TableHead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Mark</TableHead>
                  <TableHead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">SL</TableHead>
                  <TableHead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">TP</TableHead>
                  <TableHead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Floating P&amp;L</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.map((order) => (
                  <TableRow key={order.id} className="font-mono text-xs">
                    <TableCell>{getSymbol(order.symbol).displayName}</TableCell>
                    <TableCell className="text-muted-foreground">{formatStamp(order.createdAt, timeZone)}</TableCell>
                    <TableCell>
                      <SideBadge side={order.side} />
                    </TableCell>
                    <TableCell className="tabular-nums">{order.sizeLots.toFixed(2)}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">Limit {formatPrice(order.symbol, order.limitPrice)}</TableCell>
                    <TableCell className="text-muted-foreground">Working</TableCell>
                    <TableCell className="tabular-nums">{order.stopLoss == null ? '—' : formatPrice(order.symbol, order.stopLoss)}</TableCell>
                    <TableCell className="tabular-nums">{order.takeProfit == null ? '—' : formatPrice(order.symbol, order.takeProfit)}</TableCell>
                    <TableCell className="text-muted-foreground">Pending</TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Cancel ${order.symbol} pending order`}
                        disabled={Boolean(cancelling[order.id])}
                        onClick={() => void cancel(order.id)}
                      >
                        {cancelling[order.id] ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {positions.map((position) => (
                  <TableRow key={position.id} className="font-mono text-xs">
                    <TableCell>{getSymbol(position.symbol).displayName}</TableCell>
                    <TableCell className="text-muted-foreground">{formatStamp(position.openedAt, timeZone)}</TableCell>
                    <TableCell>
                      <SideBadge side={position.side} />
                    </TableCell>
                    <TableCell className="tabular-nums">{position.sizeLots.toFixed(2)}</TableCell>
                    <TableCell className="tabular-nums">{formatPrice(position.symbol, position.entryPrice)}</TableCell>
                    <TableCell className="tabular-nums">{formatPrice(position.symbol, position.currentPrice)}</TableCell>
                    <TableCell className="tabular-nums">{position.stopLoss == null ? '—' : formatPrice(position.symbol, position.stopLoss)}</TableCell>
                    <TableCell className="tabular-nums">{position.takeProfit == null ? '—' : formatPrice(position.symbol, position.takeProfit)}</TableCell>
                    <TableCell className={cn('tabular-nums font-medium', position.floatingPnl >= 0 ? 'text-primary' : 'text-danger')}>
                      {formatUsd(position.floatingPnl, { signed: true })}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Close ${position.symbol} position`}
                        disabled={Boolean(closing[position.id])}
                        onClick={() => void close(position.id)}
                      >
                        {closing[position.id] ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        <TabsContent value="history" className="p-0">
          {history.length === 0 ? (
            <Empty message="Closed trades will appear here with realized P&L and the close reason." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Closed</TableHead>
                  <TableHead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Symbol</TableHead>
                  <TableHead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Side</TableHead>
                  <TableHead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Lots</TableHead>
                  <TableHead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Entry</TableHead>
                  <TableHead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Exit</TableHead>
                  <TableHead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Realized P&amp;L</TableHead>
                  <TableHead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((trade) => (
                  <TableRow key={trade.id} className="font-mono text-xs">
                    <TableCell className="text-muted-foreground">{formatStamp(trade.closedAt, timeZone)}</TableCell>
                    <TableCell>{getSymbol(trade.symbol).displayName}</TableCell>
                    <TableCell>
                      <SideBadge side={trade.side} />
                    </TableCell>
                    <TableCell className="tabular-nums">{trade.sizeLots.toFixed(2)}</TableCell>
                    <TableCell className="tabular-nums">{formatPrice(trade.symbol, trade.entryPrice)}</TableCell>
                    <TableCell className="tabular-nums">{formatPrice(trade.symbol, trade.exitPrice)}</TableCell>
                    <TableCell className={cn('tabular-nums font-medium', trade.pnl >= 0 ? 'text-primary' : 'text-danger')}>
                      {formatUsd(trade.pnl, { signed: true })}
                    </TableCell>
                    <TableCell>{CLOSE_LABEL[trade.closeReason]}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        <TabsContent value="rules" className="p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <RuleCard
              title={`Daily loss vs ${formatPct(snapshot.dailyLossLimitPct * 100)} of day-start equity`}
              used={snapshot.dailyLossUsed}
              limit={snapshot.dailyLossLimitUsd}
              ratio={snapshot.dailyUsedRatio}
              caption={`Buffer remaining ${formatUsd(snapshot.dailyBufferUsd)}`}
            />
            <RuleCard
              title={`Trailing drawdown vs ${formatPct(snapshot.trailingDrawdownLimitPct * 100)} below peak`}
              used={snapshot.trailingDrawdownUsed}
              limit={snapshot.trailingDrawdownLimitUsd}
              ratio={snapshot.trailingUsedRatio}
              caption={`Peak ${formatUsd(snapshot.peakEquity)} · floor ${formatUsd(snapshot.trailingFloor)}`}
            />
          </div>
        </TabsContent>
      </Tabs>
    </section>
  )
}

function SideBadge({ side }: { side: OrderSide }) {
  return (
    <span
      className={cn(
        'inline-flex rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        side === 'BUY' ? 'border-primary/30 bg-primary/10 text-primary' : 'border-danger/30 bg-danger/10 text-danger',
      )}
    >
      {side}
    </span>
  )
}

function Empty({ message }: { message: string }) {
  return <p className="px-4 py-8 text-center text-sm text-muted-foreground">{message}</p>
}

function RuleCard({
  title,
  used,
  limit,
  ratio,
  caption,
}: {
  title: string
  used: number
  limit: number
  ratio: number
  caption: string
}) {
  const tone = ratio >= 0.8 ? 'text-danger' : ratio >= 0.5 ? 'text-warning' : 'text-primary'
  const bar = ratio >= 0.8 ? 'bg-danger' : ratio >= 0.5 ? 'bg-warning' : 'bg-primary'
  return (
    <article className="rounded-lg border border-border bg-background/50 p-4">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <p className={cn('mt-2 font-mono text-2xl font-semibold tabular-nums', tone)}>{formatPct(ratio * 100)} used</p>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary" role="meter" aria-valuenow={Math.round(ratio * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className={cn('h-full rounded-full', bar)} style={{ width: `${Math.max(3, ratio * 100)}%` }} />
      </div>
      <p className="mt-2 font-mono text-xs text-muted-foreground">
        {formatUsd(used)} / {formatUsd(limit)} · {caption}
      </p>
    </article>
  )
}

function formatStamp(value: Date, timeZone: string) {
  return new Date(value).toLocaleString('en-GB', {
    timeZone,
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
