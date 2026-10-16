'use client'

import { Radio } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { TelemetryState } from '@/lib/admin/types'

export function TelemetryController({
  state,
}: {
  state: TelemetryState | null
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/80 px-3 py-2">
      <Radio className="size-4 text-highlight" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground">Telemetry Status</p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {state?.lastSyncedAt
            ? `Last pulse ${new Date(state.lastSyncedAt).toLocaleTimeString()} · ${state.recordsUpdated} books`
            : 'Awaiting first poll'}
          {state?.source === 'mock' ? ' · mock fallback' : ''}
        </p>
      </div>
      <Badge variant="outline" className="font-mono text-[10px]">
        {state?.inProgress ? 'POLLING' : 'READ ONLY'}
      </Badge>
    </div>
  )
}
