'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export const INPUT_CLASS =
  'h-9 w-full rounded-md border border-input bg-background/70 px-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60'

export const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-background/70 px-2 font-mono text-xs text-foreground outline-none transition focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60'

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <label className={cn('block', className)}>
      <span className="block text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{label}</span>
      <span className="mt-1.5 block">{children}</span>
      {hint ? <span className="mt-1.5 block text-[11px] leading-relaxed text-muted-foreground">{hint}</span> : null}
    </label>
  )
}

export function Panel({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card/80 backdrop-blur-md">
      <header className="border-b border-border/70 px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {description ? <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}

export function Notice({
  tone,
  children,
}: {
  tone: 'success' | 'error' | 'info' | 'warning'
  children: ReactNode
}) {
  const styles = {
    success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    error: 'border-danger/30 bg-danger/10 text-danger',
    info: 'border-primary/25 bg-primary/10 text-primary',
    warning: 'border-warning/30 bg-warning/10 text-warning',
  }[tone]
  return (
    <p role={tone === 'error' ? 'alert' : 'status'} className={cn('rounded-md border px-3 py-2 text-xs leading-relaxed', styles)}>
      {children}
    </p>
  )
}
