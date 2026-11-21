'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { formatUsd } from '@/lib/admin/risk'
import type { PayoutRow, PayoutStatus } from '@/lib/admin/types'

type StatusFilter = 'ALL' | PayoutStatus
type PolicyFilter = 'ALL' | 'MANUAL' | 'PROVIDER'

type DialogState = { id: string; action: 'approve' | 'confirm' | 'reject' } | null

const STATUS_FILTERS: StatusFilter[] = ['ALL', 'PENDING', 'APPROVED', 'DISBURSED', 'MANUALLY_PAID', 'REJECTED']

function policyLabel(policy: string | null): string {
  if (policy === 'MANUAL_V1') return 'Manual'
  if (policy === 'EXECUTION_V1') return 'Provider'
  return 'Legacy'
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value))
}

const fieldClass =
  'h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/50 focus:ring-2 focus:ring-primary/20'

const TERMINAL_ACCOUNT_STATUSES = new Set(['ARCHIVED', 'EXPIRED'])
const BREACHED_ACCOUNT_STATUSES = new Set(['BREACHED', 'BREACHED_DAILY', 'BREACHED_MAX'])

function accountContext(item: PayoutRow): { label: string; className: string } | null {
  if (item.forfeitedAt) {
    return {
      label: `Forfeited${item.cancelSource ? ` · ${item.cancelSource}` : ''}`,
      className: 'border-destructive/40 text-destructive',
    }
  }
  if (item.accountStatus && TERMINAL_ACCOUNT_STATUSES.has(item.accountStatus)) {
    return { label: `Account ${item.accountStatus} (terminal)`, className: 'border-destructive/40 text-destructive' }
  }
  if (item.accountStatus && BREACHED_ACCOUNT_STATUSES.has(item.accountStatus)) {
    return { label: 'Account breached (appeal possible)', className: 'border-amber-500/40 text-amber-600' }
  }
  return null
}

export function PayoutQueue({
  open,
  onOpenChange,
  items,
  canApprove,
  canConfirmPayouts,
  onApprove,
  onManualApprove,
  onManualConfirm,
  onManualReject,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: PayoutRow[]
  canApprove: boolean
  canConfirmPayouts: boolean
  onApprove: (id: string, txHash: string, reason: string) => Promise<void>
  onManualApprove: (id: string) => Promise<void>
  onManualConfirm: (id: string, transactionRef: string, paymentMethod: string) => Promise<void>
  onManualReject: (id: string, reason: string) => Promise<void>
}) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL')
  const [policyFilter, setPolicyFilter] = useState<PolicyFilter>('ALL')
  const [legacyHashes, setLegacyHashes] = useState<Record<string, string>>({})
  const [legacyReasons, setLegacyReasons] = useState<Record<string, string>>({})
  const [confirmRef, setConfirmRef] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('Manual transfer')
  const [rejectReason, setRejectReason] = useState('')
  const [dialog, setDialog] = useState<DialogState>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const visible = items.filter((item) => {
    if (statusFilter !== 'ALL' && item.status !== statusFilter) return false
    if (policyFilter === 'MANUAL' && item.executionPolicy !== 'MANUAL_V1') return false
    if (policyFilter === 'PROVIDER' && item.executionPolicy === 'MANUAL_V1') return false
    return true
  })
  const pendingCount = items.filter((item) => item.status === 'PENDING').length

  const activeItem = dialog ? (items.find((item) => item.id === dialog.id) ?? null) : null
  const dialogBusy = activeItem != null && busy === activeItem.id

  async function run(id: string, fn: () => Promise<void>) {
    setBusy(id)
    setNotice(null)
    try {
      await fn()
      setDialog(null)
      setConfirmRef('')
      setPaymentMethod('Manual transfer')
      setRejectReason('')
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Payout queue</SheetTitle>
          <SheetDescription>{pendingCount} pending · USDT rails only</SheetDescription>
        </SheetHeader>

        <div className="flex flex-wrap gap-2 px-4 pb-3">
          <select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
            className="h-8 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-highlight"
          >
            {STATUS_FILTERS.map((status) => (
              <option key={status} value={status}>
                {status === 'ALL' ? 'All statuses' : status}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by policy"
            value={policyFilter}
            onChange={(event) => setPolicyFilter(event.target.value as PolicyFilter)}
            className="h-8 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-highlight"
          >
            <option value="ALL">All policies</option>
            <option value="MANUAL">Manual (MANUAL_V1)</option>
            <option value="PROVIDER">Provider / Legacy</option>
          </select>
        </div>

        {notice && (
          <p className="mx-4 mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{notice}</p>
        )}

        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 pb-6">
          {visible.length === 0 && (
            <p className="py-8 text-center text-xs text-muted-foreground">No payouts match the current filters.</p>
          )}
          {visible.map((item) => {
            const isManual = item.executionPolicy === 'MANUAL_V1'
            const isBusy = busy === item.id
            return (
              <div key={item.id} className="rounded-lg border border-border bg-secondary/40 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-mono text-sm text-foreground">{item.accountDisplayId}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.traderName} · {item.traderEmail}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {item.status}
                    </Badge>
                    <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
                      {policyLabel(item.executionPolicy)}
                    </Badge>
                  </div>
                </div>

                <p className="mt-2 font-mono text-lg text-primary">{formatUsd(item.amount)}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {item.balanceReserved && (
                    <Badge variant="outline" className="font-mono text-[10px] text-primary">
                      Reserved
                    </Badge>
                  )}
                  {(() => {
                    const context = accountContext(item)
                    return context ? (
                      <Badge variant="outline" className={`font-mono text-[10px] ${context.className}`}>
                        {context.label}
                      </Badge>
                    ) : null
                  })()}
                </div>
                {item.breachReason && item.accountStatus && BREACHED_ACCOUNT_STATUSES.has(item.accountStatus) && (
                  <p className="mt-1 text-[11px] text-muted-foreground">Breach reason: {item.breachReason}</p>
                )}
                <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                  {item.network} · {item.walletAddress}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Split {item.profitSplitPct}% · Requested {formatDate(item.requestedAt)}
                  {item.txHash ? ` · ${item.txHash}` : ''}
                </p>

                {item.status === 'REJECTED' && item.rejectReason && (
                  <p className="mt-2 rounded-md border border-border bg-background px-2 py-1.5 text-[11px] text-muted-foreground">
                    Rejected: {item.rejectReason}
                  </p>
                )}

                {item.status === 'MANUALLY_PAID' && (
                  <div className="mt-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-[11px]">
                    <p className="text-muted-foreground">
                      Paid {item.paidCurrency ?? ''} · {item.paymentMethod ?? ''}
                      {item.paidAt ? ` · ${formatDate(item.paidAt)}` : ''}
                    </p>
                    {item.transactionRef && (
                      <p className="mt-0.5 break-all font-mono text-foreground">Ref: {item.transactionRef}</p>
                    )}
                  </div>
                )}

                {isManual && canConfirmPayouts && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {item.status === 'PENDING' && (
                      <Button size="sm" disabled={isBusy} onClick={() => setDialog({ id: item.id, action: 'approve' })}>
                        Approve
                      </Button>
                    )}
                    {item.status === 'APPROVED' && (
                      <>
                        <Button size="sm" disabled={isBusy} onClick={() => { setConfirmRef(''); setPaymentMethod('Manual transfer'); setDialog({ id: item.id, action: 'confirm' }) }}>
                          Confirm payment
                        </Button>
                        <Button size="sm" variant="outline" disabled={isBusy} onClick={() => { setRejectReason(''); setDialog({ id: item.id, action: 'reject' }) }}>
                          Reject
                        </Button>
                      </>
                    )}
                  </div>
                )}

                {!isManual && item.status === 'PENDING' && canApprove && (
                  <div className="mt-3 flex flex-col gap-2">
                    <input
                      value={legacyHashes[item.id] ?? ''}
                      onChange={(event) => setLegacyHashes((prev) => ({ ...prev, [item.id]: event.target.value }))}
                      placeholder="Transaction hash / tx id"
                      className="h-8 rounded-md border border-border bg-background px-2.5 font-mono text-xs outline-none focus:border-highlight"
                    />
                    <input
                      value={legacyReasons[item.id] ?? ''}
                      onChange={(event) => setLegacyReasons((prev) => ({ ...prev, [item.id]: event.target.value }))}
                      placeholder="Approval reason (required for legacy payouts)"
                      className="h-8 rounded-md border border-border bg-background px-2.5 text-xs outline-none focus:border-highlight"
                    />
                    <Button
                      size="sm"
                      disabled={isBusy || !(legacyHashes[item.id] ?? '').trim()}
                      onClick={() =>
                        run(item.id, () => onApprove(item.id, legacyHashes[item.id].trim(), (legacyReasons[item.id] ?? '').trim()))
                      }
                    >
                      Approve & Mark Paid
                    </Button>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Approve dialog */}
        <Dialog open={dialog?.action === 'approve'} onOpenChange={(next) => !next && setDialog(null)}>
          <DialogContent className="border-border bg-card sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Approve manual payout</DialogTitle>
              <DialogDescription>
                Approve {activeItem ? `${activeItem.traderName} (${formatUsd(activeItem.amount)})` : 'this payout'} for a manual,
                off-platform transfer. No money is moved by PFT.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialog(null)} disabled={dialogBusy}>
                Cancel
              </Button>
              <Button disabled={dialogBusy} onClick={() => activeItem && run(activeItem.id, () => onManualApprove(activeItem.id))}>
                Approve
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Confirm dialog */}
        <Dialog open={dialog?.action === 'confirm'} onOpenChange={(next) => !next && setDialog(null)}>
          <DialogContent className="border-border bg-card sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Confirm manual payment</DialogTitle>
              <DialogDescription>
                Funds must already be transferred outside PFT. This only records the payment — PFT never transfers money
                itself.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <label className="grid gap-1.5 text-xs">
                <span className="text-muted-foreground">Transaction reference (required)</span>
                <input
                  value={confirmRef}
                  onChange={(event) => setConfirmRef(event.target.value)}
                  placeholder="External payment reference / tx id"
                  className={fieldClass}
                />
              </label>
              <label className="grid gap-1.5 text-xs">
                <span className="text-muted-foreground">Payment method</span>
                <input
                  value={paymentMethod}
                  onChange={(event) => setPaymentMethod(event.target.value)}
                  placeholder="Manual transfer"
                  className={fieldClass}
                />
              </label>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialog(null)} disabled={dialogBusy}>
                Cancel
              </Button>
              <Button
                disabled={dialogBusy || !confirmRef.trim() || !paymentMethod.trim()}
                onClick={() => activeItem && run(activeItem.id, () => onManualConfirm(activeItem.id, confirmRef.trim(), paymentMethod.trim()))}
              >
                Confirm payment
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Reject dialog */}
        <Dialog open={dialog?.action === 'reject'} onOpenChange={(next) => !next && setDialog(null)}>
          <DialogContent className="border-border bg-card sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Reject manual payout</DialogTitle>
              <DialogDescription>Releases the reserved funds back to the trader. This cannot be undone.</DialogDescription>
            </DialogHeader>
            <label className="grid gap-1.5 text-xs">
              <span className="text-muted-foreground">Reason (required)</span>
              <input
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
                placeholder="Why the payout is being rejected"
                className={fieldClass}
              />
            </label>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialog(null)} disabled={dialogBusy}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={dialogBusy || !rejectReason.trim()}
                onClick={() => activeItem && run(activeItem.id, () => onManualReject(activeItem.id, rejectReason.trim()))}
              >
                Reject payout
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  )
}
