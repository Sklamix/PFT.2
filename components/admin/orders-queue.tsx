'use client'

import { ExternalLink } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { formatUsd } from '@/lib/admin/risk'
import type { OrderRow } from '@/lib/admin/types'

export function OrdersQueue({
  open,
  onOpenChange,
  items,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: OrderRow[]
}) {
  const pending = items.filter((item) => item.status === 'PENDING').length

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Orders &amp; payments</SheetTitle>
          <SheetDescription>{items.length} latest orders · {pending} pending payment</SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 pb-6">
          {items.length === 0 && (
            <p className="rounded-md border border-border px-3 py-6 text-center text-sm text-muted-foreground">
              No orders found.
            </p>
          )}
          {items.map((item) => (
            <article key={item.id} className="rounded-lg border border-border bg-secondary/40 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-mono text-sm text-foreground">{formatUsd(item.amount)} {item.currency}</p>
                  <p className="truncate text-xs text-muted-foreground">{item.userEmail}</p>
                </div>
                <Badge variant="outline" className="font-mono text-[10px]">{item.status}</Badge>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
                <div>
                  <dt className="text-muted-foreground">Provider</dt>
                  <dd className="mt-0.5 font-mono">{item.provider}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Account</dt>
                  <dd className="mt-0.5 font-mono">{item.accountDisplayId ?? 'Not provisioned'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Created</dt>
                  <dd className="mt-0.5">{new Date(item.createdAt).toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Invoice email</dt>
                  <dd className="mt-0.5 font-mono">{item.invoiceEmailStatus ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Credentials email</dt>
                  <dd className="mt-0.5 font-mono">{item.credentialsEmailStatus ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Provisioned</dt>
                  <dd className="mt-0.5">{item.provisionedAt ? new Date(item.provisionedAt).toLocaleString() : 'No'}</dd>
                </div>
              </dl>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-2">
                <p className="truncate font-mono text-[11px] text-muted-foreground">{item.providerOrderId}</p>
                {item.paymentUrl && (
                  <a
                    href={item.paymentUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <ExternalLink className="size-3.5" />
                    Open invoice
                  </a>
                )}
              </div>
            </article>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  )
}