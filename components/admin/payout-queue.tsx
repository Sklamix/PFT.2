'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { formatSla, formatUsd } from '@/lib/admin/risk'
import type { PayoutRow } from '@/lib/admin/types'

export function PayoutQueue({
  open,
  onOpenChange,
  items,
  canApprove,
  onApprove,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: PayoutRow[]
  canApprove: boolean
  onApprove: (id: string, txHash: string) => Promise<void>
}) {
  const pending = items.filter((item) => item.status === 'PENDING')
  const [hashes, setHashes] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Payout disbursement queue</SheetTitle>
          <SheetDescription>
            {pending.length} pending · 80–90% profit split · USDT rails only
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 pb-6">
          {items.map((item) => (
            <div key={item.id} className="rounded-lg border border-border bg-secondary/40 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-mono text-sm text-foreground">{item.accountDisplayId}</p>
                  <p className="text-xs text-muted-foreground">
                    {item.traderName} · {item.traderEmail}
                  </p>
                </div>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {item.status}
                </Badge>
              </div>
              <p className="mt-2 font-mono text-lg text-primary">{formatUsd(item.amount)}</p>
              <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                {item.network} · {item.walletAddress}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Split {item.profitSplitPct}% · SLA {formatSla(item.slaMinutes)}
                {item.txHash ? ` · ${item.txHash}` : ''}
              </p>
              {item.status === 'PENDING' && canApprove && (
                <div className="mt-3 flex flex-col gap-2">
                  <input
                    value={hashes[item.id] ?? ''}
                    onChange={(event) => setHashes((prev) => ({ ...prev, [item.id]: event.target.value }))}
                    placeholder="Transaction hash / tx id"
                    className="h-8 rounded-md border border-border bg-background px-2.5 font-mono text-xs outline-none focus:border-highlight"
                  />
                  <Button
                    size="sm"
                    disabled={busy === item.id || !(hashes[item.id] ?? '').trim()}
                    onClick={async () => {
                      setBusy(item.id)
                      try {
                        await onApprove(item.id, hashes[item.id].trim())
                      } finally {
                        setBusy(null)
                      }
                    }}
                  >
                    Approve & Mark Paid
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  )
}
