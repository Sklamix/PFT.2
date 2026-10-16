'use client'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatUsd } from '@/lib/admin/risk'
import type { TradeRow, TraderRow } from '@/lib/admin/types'

export function TradeHistoryModal({
  open,
  onOpenChange,
  account,
  trades,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: TraderRow | null
  trades: TradeRow[]
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-card sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="font-mono">{account?.displayId} · trade ledger</DialogTitle>
          <DialogDescription>
            {account?.traderName} · MT5 {account?.mt5Login} @ {account?.mt5Server}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Position / trade</TableHead>
                <TableHead>Symbol</TableHead>
                <TableHead>Side</TableHead>
                <TableHead>Lots</TableHead>
                <TableHead>Open</TableHead>
                <TableHead>Close</TableHead>
                <TableHead>P/L</TableHead>
                <TableHead>State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trades.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-muted-foreground">
                    No terminal trades or positions.
                  </TableCell>
                </TableRow>
              )}
              {trades.map((trade) => (
                <TableRow key={trade.id}>
                  <TableCell className="font-mono">{trade.ticket}</TableCell>
                  <TableCell>{trade.symbol}</TableCell>
                  <TableCell className={trade.side === 'BUY' ? 'text-primary' : 'text-destructive'}>{trade.side}</TableCell>
                  <TableCell className="font-mono">{trade.lots.toFixed(2)}</TableCell>
                  <TableCell className="font-mono">{trade.openPrice}</TableCell>
                  <TableCell className="font-mono">{trade.closePrice ?? '—'}</TableCell>
                  <TableCell className={trade.profit >= 0 ? 'font-mono text-primary' : 'font-mono text-destructive'}>
                    {formatUsd(trade.profit)}
                  </TableCell>
                  <TableCell className="font-mono text-[11px]">
                    {trade.status}
                    {trade.markedForLiquidation ? ' · LIQ' : ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  )
}
