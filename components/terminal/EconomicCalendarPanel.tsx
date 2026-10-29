'use client'

import { useState } from 'react'
import { ChevronDown, Radio } from 'lucide-react'
import { EconomicCalendar } from '@/components/dashboard/EconomicCalendar'
import { cn } from '@/lib/utils'

export function EconomicCalendarPanel() {
  const [open, setOpen] = useState(false)

  return (
    <section className="rounded-xl border border-border bg-card/60">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-xs"
      >
        <span className="flex items-center gap-2 font-semibold text-foreground">
          <Radio className="size-3.5 text-danger" aria-hidden="true" />
          Economic calendar
        </span>
        <ChevronDown className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open ? (
        <div className="border-t border-border px-3 py-2.5">
          <EconomicCalendar compact />
        </div>
      ) : null}
    </section>
  )
}
