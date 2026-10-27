'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const MIN_REASON = 20

export function AppealDialog({
  accountId,
  open,
  onOpenChange,
}: {
  accountId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/trading/appeal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, reason }),
      })
      const data = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) throw new Error(data.error || 'Unable to file the appeal')
      setSent(true)
      setReason('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to file the appeal')
    } finally {
      setBusy(false)
    }
  }

  function close(next: boolean) {
    if (!next) {
      setError(null)
      setSent(false)
      setReason('')
    }
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Appeal this decision</DialogTitle>
          <DialogDescription>
            An admin who did not close the account reviews every appeal. Overturning restores the account to its previous
            phase.
          </DialogDescription>
        </DialogHeader>

        {sent ? (
          <p className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">
            Appeal filed. You can track the outcome in this dialog.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <label htmlFor="appeal-reason" className="text-xs font-medium text-muted-foreground">
              What should the reviewer know? (at least {MIN_REASON} characters)
            </label>
            <textarea
              id="appeal-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={5}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="Describe why the breach decision should be reviewed."
            />
            {error && <p className="text-xs text-danger">{error}</p>}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>
            {sent ? 'Close' : 'Cancel'}
          </Button>
          {!sent && (
            <Button disabled={busy || reason.trim().length < MIN_REASON} onClick={() => void submit()}>
              {busy ? 'Filing…' : 'File appeal'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
