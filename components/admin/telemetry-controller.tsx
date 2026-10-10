'use client'

import { Radio, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { TelemetryState } from '@/lib/admin/types'

export function TelemetryController({
  state,
  syncing,
  onSync,
}: {
  state: TelemetryState | null
  syncing: boolean
  onSync: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/80 px-3 py-2">
      <Radio className="size-4 text-highlight" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground">Telemetry Sync Controller</p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {state?.lastSyncedAt
            ? `Last pulse ${new Date(state.lastSyncedAt).toLocaleTimeString()} · ${state.recordsUpdated} books`
            : 'Awaiting first poll'}
          {state?.source === 'mock' ? ' · mock fallback' : ''}
        </p>
      </div>
      <Badge variant="outline" className="font-mono text-[10px]">
        {state?.inProgress || syncing ? 'POLLING' : 'IDLE'}
      </Badge>
      <Button size="sm" onClick={onSync} disabled={syncing}>
        <RefreshCw className={syncing ? 'animate-spin' : undefined} />
        Sync Live Telemetry
      </Button>
    </div>
  )
}
