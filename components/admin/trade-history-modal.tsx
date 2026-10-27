'use client'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatUsd } from '@/lib/admin/risk'
import type { TradeRow, TraderRow } from '@/lib/admin/types'

export function TradeHistoryModal({
  open,
  onOpenChange,
  account,
  trades,
  payoutHold,
  onHold,
  onClearHold,
  onVoid,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: TraderRow | null
  trades: TradeRow[]
  payoutHold: { active: boolean; reason: string | null } | null
  onHold: () => void
  onClearHold: () => void
  onVoid: (trade: TradeRow) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-card sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="font-mono">{account?.displayId} · trade ledger</DialogTitle>
          <DialogDescription>
            {account?.traderName} · login {account?.mt5Login} @ {account?.mt5Server}
          </DialogDescription>
          <div className="flex flex-wrap items-center gap-2 pt-2">
            {payoutHold?.active ? (
              <>
                <span className="text-xs text-destructive">Payout hold: {payoutHold.reason ?? 'review required'}</span>
                <Button size="xs" variant="outline" onClick={onClearHold}>Clear payout hold</Button>
              </>
            ) : (
              <Button size="xs" variant="outline" onClick={onHold}>Hold payouts</Button>
            )}
          </div>
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
                    {trade.voidedAt ? `VOIDED · ${trade.voidReason ?? ''}` : trade.status}
                    {trade.markedForLiquidation ? ' · LIQ' : ''}
                    {trade.status === 'CLOSED' && !trade.voidedAt && (
                      <Button
                        size="xs"
                        variant="ghost"
                        className="ml-2 h-6 px-2 text-[10px] text-destructive"
                        onClick={() => onVoid(trade)}
                      >
                        Void
                      </Button>
                    )}
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
