'use client'

import type { ReactElement } from 'react'
import { cn } from '@/lib/utils'

/**
 * Three animated dots shown while an AI or agent response is being generated.
 * Respects prefers-reduced-motion: without it the dots are static and the
 * status label is still announced.
 */
export function TypingDots({ label = 'Assistant is typing' }: { label?: string }): ReactElement {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      className={cn('flex items-center gap-1 px-1 py-0.5')}
    >
      <span className="size-1.5 rounded-full bg-primary/60 animate-dot-bounce" aria-hidden="true" />
      <span className="size-1.5 rounded-full bg-primary/60 animate-dot-bounce" style={{ animationDelay: '120ms' }} aria-hidden="true" />
      <span className="size-1.5 rounded-full bg-primary/60 animate-dot-bounce" style={{ animationDelay: '240ms' }} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </div>
  )
}
