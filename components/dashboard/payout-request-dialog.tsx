'use client'

import { useState } from 'react'
import { CircleAlert, CircleCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatUsd, getMetrics, type TradingAccount } from '@/lib/dashboard-data'
import { cn } from '@/lib/utils'

const METHODS = ['USDT (TRC-20)', 'Bank wire', 'Rise'] as const

type PayoutRequestDialogProps = {
  account: TradingAccount
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function PayoutRequestDialog({ account, open, onOpenChange }: PayoutRequestDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-card sm:max-w-md">
        {open && <PayoutRequestBody key={account.id} account={account} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function PayoutRequestBody({ account, onClose }: { account: TradingAccount; onClose: () => void }) {
  const [method, setMethod] = useState<(typeof METHODS)[number]>(METHODS[0])
  const [submitted, setSubmitted] = useState(false)
  const metrics = getMetrics(account)

  if (account.status !== 'funded') {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Payout not available yet</DialogTitle>
          <DialogDescription>
            {account.status === 'breached'
              ? `${account.id} breached a hard rule and is no longer eligible for disbursement.`
              : `${account.id} is in ${account.phase}. Payouts unlock once you complete the evaluation and receive a Funded account.`}
          </DialogDescription>
        </DialogHeader>
        <p className="flex items-start gap-2 rounded-md border border-border bg-background p-3 text-sm text-muted-foreground">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          Switch to a Funded account from the account selector to request a disbursement.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </>
    )
  }

  if (submitted) {
    return (
      <div className="flex flex-col items-center gap-3 py-4 text-center">
        <CircleCheck className="size-10 text-primary" aria-hidden="true" />
        <DialogTitle>Payout request submitted</DialogTitle>
        <DialogDescription>
          {formatUsd(metrics.traderShare)} via {method} is queued for the next disbursement window. You will be notified when it is processed.
        </DialogDescription>
        <Button className="mt-2" onClick={onClose}>
          Done
        </Button>
      </div>
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Request payout</DialogTitle>
        <DialogDescription>Profit share from {account.id} for the current bi-weekly cycle.</DialogDescription>
      </DialogHeader>
      <dl className="grid grid-cols-2 gap-2 font-mono text-sm">
        <div className="rounded-lg border border-border bg-background p-3">
          <dt className="text-[10px] uppercase tracking-widest text-muted-foreground">Gross profit</dt>
          <dd className="mt-1 text-foreground">{formatUsd(metrics.profit)}</dd>
        </div>
        <div className="rounded-lg border border-primary/30 bg-primary/10 p-3">
          <dt className="text-[10px] uppercase tracking-widest text-primary">Your {account.profitSplit}% share</dt>
          <dd className="mt-1 font-semibold text-primary">{formatUsd(metrics.traderShare)}</dd>
        </div>
      </dl>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium text-foreground">Payout method</legend>
        {METHODS.map((item) => (
          <label
            key={item}
            className={cn(
              'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors',
              method === item ? 'border-primary/50 bg-primary/5 text-foreground' : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            <input
              type="radio"
              name="payout-method"
              value={item}
              checked={method === item}
              onChange={() => setMethod(item)}
              className="accent-[var(--primary)]"
            />
            {item}
          </label>
        ))}
      </fieldset>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => setSubmitted(true)}>Confirm request</Button>
      </DialogFooter>
    </>
  )
}
