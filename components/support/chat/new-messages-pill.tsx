'use client'

import { ArrowDown } from 'lucide-react'
import { newMessagesLabel } from '@/lib/support/live'
import { cn } from '@/lib/utils'

/**
 * Floating "N new messages" pill.
 *
 * Rendered inside a `relative` wrapper around the scroll container; the pill
 * itself stays out of the scroll flow so it cannot push content around.
 */
export function NewMessagesPill({
  count,
  onClick,
  locale = 'en',
  className,
}: {
  count: number
  onClick: () => void
  locale?: 'en' | 'uk'
  className?: string
}) {
  if (count <= 0) return null
  const label = newMessagesLabel(count, locale)
  return (
    <div className={cn('pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center', className)}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className="pointer-events-auto flex animate-pill-in items-center gap-1.5 rounded-full border border-primary/40 bg-primary/20 px-3 py-1.5 text-xs font-medium text-primary shadow-lg backdrop-blur-md transition-colors hover:bg-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <ArrowDown className="size-3.5" />
        {label}
      </button>
    </div>
  )
}
