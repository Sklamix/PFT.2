'use client'

import { ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { AccountStatus, PendingAccountOverride } from '@/lib/admin/types'

const STATUS_LABELS: Record<AccountStatus, string> = {
  ACTIVE: 'Active',
  PASSED_PHASE_1: 'Passed Phase 1',
  PASSED_PHASE_2: 'Passed Phase 2',
  FUNDED: 'Funded',
  BREACHED_DAILY: 'Breached daily loss',
  BREACHED_MAX: 'Breached max loss',
  FROZEN_STANDBY: 'Frozen standby',
  BREACHED: 'Breached',
  PASSED: 'Passed',
}

function requestedLabel(iso: string) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

export function OverrideApprovals({
  items,
  onApprove,
  onReject,
}: {
  items: PendingAccountOverride[]
  onApprove: (item: PendingAccountOverride) => void
  onReject: (item: PendingAccountOverride) => void
}) {
  if (items.length === 0) return null

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
          Pending account overrides
        </h2>
        <p className="text-xs text-muted-foreground">
          Every manual status change needs a reason and a second admin. Requests expire after 24 hours.
        </p>
      </div>
      <ul className="mt-3 divide-y divide-border">
        {items.map((item) => {
          const disabled = item.expired || item.selfRequested
          return (
            <li key={item.requestId} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-0.5">
                <p className="text-sm font-medium">
                  {item.displayId} · {item.traderName} → {STATUS_LABELS[item.status] ?? item.status}
                </p>
                <p className="text-xs text-muted-foreground">
                  {item.reason || 'No reason supplied'} · requested by {item.requestedBy} ·{' '}
                  {requestedLabel(item.requestedAt)}
                </p>
                {item.expired && (
                  <p className="text-xs text-destructive">Expired. The requesting admin must create a new request.</p>
                )}
                {item.selfRequested && !item.expired && (
                  <p className="text-xs text-muted-foreground">Awaiting approval from a different admin.</p>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="xs" disabled={disabled} onClick={() => onApprove(item)}>
                  Approve override
                </Button>
                <Button size="xs" variant="outline" disabled={disabled} onClick={() => onReject(item)}>
                  Reject
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
