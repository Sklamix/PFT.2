'use client'

import { ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { PendingActionReview } from '@/lib/admin/types'

const KIND_LABELS: Record<PendingActionReview['kind'], string> = {
  BREACH: 'Breach kill-switch',
  RESET: 'Admin reset',
}

function timeLabel(iso: string) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

export function ActionReviews({
  items,
  onConfirm,
  onFlag,
}: {
  items: PendingActionReview[]
  onConfirm: (item: PendingActionReview) => void
  onFlag: (item: PendingActionReview) => void
}) {
  if (items.length === 0) return null

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <ShieldAlert className="size-4 text-primary" aria-hidden="true" />
          Post-action reviews
        </h2>
        <p className="text-xs text-muted-foreground">
          Breach kill-switches and resets run immediately. A different admin must confirm or flag each one within
          24 hours.
        </p>
      </div>
      <ul className="mt-3 divide-y divide-border">
        {items.map((item) => (
          <li key={item.requestId} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-0.5">
              <p className="text-sm font-medium">
                {item.displayId} · {item.traderName} · {KIND_LABELS[item.kind] ?? item.kind}
              </p>
              <p className="text-xs text-muted-foreground">
                {item.summary || 'No summary'} · performed by {item.performedBy} · {timeLabel(item.performedAt)}
              </p>
              {item.overdue && (
                <p className="text-xs text-destructive">Overdue. Review as soon as possible and note the delay.</p>
              )}
              {item.selfPerformed && (
                <p className="text-xs text-muted-foreground">Awaiting review from a different admin.</p>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button size="xs" disabled={item.selfPerformed} onClick={() => onConfirm(item)}>
                Confirm
              </Button>
              <Button size="xs" variant="outline" disabled={item.selfPerformed} onClick={() => onFlag(item)}>
                Flag
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
