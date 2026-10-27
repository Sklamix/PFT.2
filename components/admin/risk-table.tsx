'use client'

import { MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DrawdownGauge } from '@/components/admin/drawdown-gauge'
import { RiskStatusBadge } from '@/components/admin/status-badge'
import { cn } from '@/lib/utils'
import { challengeLabel, formatUsd, phaseLabel } from '@/lib/admin/risk'
import type { TraderRow } from '@/lib/admin/types'

export function RiskTable({
  rows,
  onTrades,
  onBreach,
  onKyc,
  onOverride,
  onRefresh,
  onRiskFlag,
}: {
  rows: TraderRow[]
  onTrades: (row: TraderRow) => void
  onBreach: (row: TraderRow) => void
  onKyc: (row: TraderRow) => void
  onOverride: (row: TraderRow) => void
  onRefresh: (row: TraderRow) => void
  onRiskFlag: (row: TraderRow) => void
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="bg-secondary/50">
            <TableHead>Account / Trader</TableHead>
            <TableHead>Tier & Leverage</TableHead>
            <TableHead>Daily DD</TableHead>
            <TableHead>Overall DD</TableHead>
            <TableHead>Open Risk</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                No books match this filter.
              </TableCell>
            </TableRow>
          )}
          {rows.map((row) => (
            <TableRow
              key={row.id}
              className={cn(
                'align-top',
                row.riskBadge === 'NEAR LIMIT' && 'bg-warning/5',
                row.riskBadge === 'RULE BREACHED' && 'bg-destructive/5',
              )}
            >
              <TableCell>
                <p className="font-mono text-sm text-foreground">{row.displayId}</p>
                <p className="text-xs text-muted-foreground">{row.traderName}</p>
                <p className="font-mono text-[11px] text-muted-foreground">
                  {row.mt5Login} · {row.traderEmail}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  KYC:{' '}
                  <span
                    className={cn(
                      'font-semibold',
                      row.kycStatus === 'APPROVED' && 'text-primary',
                      row.kycStatus === 'PENDING' && 'text-warning',
                      row.kycStatus === 'REJECTED' && 'text-destructive',
                    )}
                  >
                    {row.kycStatus}
                  </span>
                </p>
                {row.riskFlagged ? (
                  <p
                    className="mt-0.5 text-[11px] font-semibold text-destructive"
                    title={row.riskFlagReason ?? undefined}
                  >
                    RISK REVIEW · purchases and payouts paused
                  </p>
                ) : null}
              </TableCell>
              <TableCell>
                <p className="text-sm">{formatUsd(row.planSize, true)} · {challengeLabel(row.challengeType)}</p>
                <p className="font-mono text-[11px] text-muted-foreground">
                  {phaseLabel(row.phase)} · {row.leverage}
                </p>
              </TableCell>
              <TableCell>
                <DrawdownGauge value={row.dailyDrawdownPct} limit={row.dailyDrawdownLimitPct} label="Daily" />
              </TableCell>
              <TableCell>
                <DrawdownGauge value={row.maxDrawdownPct} limit={row.maxDrawdownLimitPct} label="Max" />
              </TableCell>
              <TableCell>
                <p className="font-mono text-sm">{row.openLots.toFixed(2)} lots</p>
                <p className="text-[11px] text-muted-foreground">{row.openPositions} open</p>
                <p className="font-mono text-[11px] text-muted-foreground">{formatUsd(row.currentEquity)}</p>
              </TableCell>
              <TableCell>
                <RiskStatusBadge badge={row.riskBadge} />
              </TableCell>
              <TableCell className="text-right">
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
                    <MoreHorizontal />
                    <span className="sr-only">Row actions</span>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => onTrades(row)}>View trade history</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onRefresh(row)}>Reload account data</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onKyc(row)}>Manage KYC</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onOverride(row)}>Override status</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onRiskFlag(row)}>
                      {row.riskFlagged ? 'Clear risk review' : 'Open risk review'}
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => onBreach(row)}>
                      Kill-switch / breach
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
