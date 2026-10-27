'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type Eligibility =
  | {
      eligible: true
      price: number
      discountPct: number
      planSize: number
      challengeType: string
      drawdownMode: string
    }
  | { eligible: false; code: string; reason: string }

export function ResetAccountDialog({
  accountId,
  open,
  onOpenChange,
}: {
  accountId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [state, setState] = useState<Eligibility | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const response = await fetch(`/api/accounts/${accountId}/reset`, { cache: 'no-store' })
      const data = (await response.json().catch(() => ({}))) as Eligibility | { error?: string }
      if (!response.ok) throw new Error((data as { error?: string }).error || 'Unable to check reset eligibility')
      setState(data as Eligibility)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to check reset eligibility')
    }
  }, [accountId])

  useEffect(() => {
    if (open) {
      setState(null)
      void load()
    }
  }, [open, load])

  async function checkout() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/accounts/${accountId}/reset/checkout`, { method: 'POST' })
      const data = (await response.json().catch(() => ({}))) as { url?: string; error?: string }
      if (!response.ok || !data.url) throw new Error(data.error || 'Unable to start the reset checkout')
      window.location.href = data.url
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start the reset checkout')
      setBusy(false)
    }
  }

  const price = state?.eligible ? state.price.toFixed(2) : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset account</DialogTitle>
          <DialogDescription>
            A reset provisions a fresh Phase 1 account with the same size and program. The closed account stays in your
            history, and the evaluation fee is not refunded.
          </DialogDescription>
        </DialogHeader>

        {!state && !error ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Checking eligibility…
          </p>
        ) : null}

        {state?.eligible ? (
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex items-baseline justify-between gap-4 rounded-md border border-border bg-secondary/40 px-3 py-2">
              <span className="text-muted-foreground">Reset price</span>
              <span className="font-mono text-lg font-semibold tabular-nums">${price}</span>
            </div>
            {state.discountPct > 0 ? (
              <p className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-primary">
                {state.discountPct}% breach-week discount applied. The discount is available for 2 days after the breach.
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Payment is collected in USDT (TRC20). The new account appears in your terminal automatically after the
              payment confirms.
            </p>
          </div>
        ) : null}

        {state && !state.eligible ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {state.reason}
          </p>
        ) : null}

        {error ? <p className="text-xs text-danger">{error}</p> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {state?.eligible ? (
            <Button disabled={busy} onClick={() => void checkout()}>
              {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}
              {busy ? 'Redirecting…' : `Pay $${price}`}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
