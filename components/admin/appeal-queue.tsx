'use client'

import { Gavel } from 'lucide-react'
import { Button } from '@/components/ui/button'

export type AppealItem = {
  id: string
  accountId: string
  displayId: string
  traderName: string
  traderEmail: string
  breachKind: string | null
  breachReason: string | null
  reason: string
  filedAt: string
  windowClosed: boolean
  appealWindowDays: number
}

function timeLabel(iso: string) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

export function AppealQueue({
  items,
  onUphold,
  onOverturn,
}: {
  items: AppealItem[]
  onUphold: (item: AppealItem) => void
  onOverturn: (item: AppealItem) => void
}) {
  if (items.length === 0) return null

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <Gavel className="size-4 text-primary" aria-hidden="true" />
          Breach appeals
        </h2>
        <p className="text-xs text-muted-foreground">
          Decided by an admin who did not close the account. Overturning restores the account status.
        </p>
      </div>
      <ul className="mt-3 divide-y divide-border">
        {items.map((item) => (
          <li key={item.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">
                {item.displayId} · {item.traderName} · {item.breachKind ?? 'Breach'}
              </p>
              <p className="text-xs text-muted-foreground">
                Closed for: {item.breachReason ?? 'unknown reason'} · filed {timeLabel(item.filedAt)}
              </p>
              <p className="max-w-2xl text-xs text-foreground/80">{item.reason}</p>
              {item.windowClosed && (
                <p className="text-xs text-destructive">
                  Appeal window closed ({item.appealWindowDays} days). Uphold unless there is a clear platform error.
                </p>
              )}
              <p className="text-xs text-muted-foreground">{item.traderEmail}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button size="xs" onClick={() => onOverturn(item)}>
                Overturn
              </Button>
              <Button size="xs" variant="outline" onClick={() => onUphold(item)}>
                Uphold
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
