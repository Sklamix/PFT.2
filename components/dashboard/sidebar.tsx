'use client'

import Link from 'next/link'
import { LogOut } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DASHBOARD_VIEWS, TERMINAL_NAV, type DashboardView, type DeskNavId } from './nav-config'

type SidebarContentProps = {
  view: DeskNavId
  onNavigate: (view: DashboardView) => void
}

export function SidebarContent({ view, onNavigate }: SidebarContentProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="nebula-atmosphere relative flex flex-col gap-3 border-b border-border px-5 py-5">
        <Link href="/" className="group flex w-fit items-center gap-2.5" aria-label="PFT terminal home">
          {/* Orbital mark: planet with a thin orbit arc and a satellite dot. */}
          <span className="relative grid size-8 place-items-center" aria-hidden="true">
            <svg viewBox="0 0 32 32" className="size-8">
              <circle cx="16" cy="16" r="6" fill="none" stroke="url(#pft-orbit)" strokeWidth="1.5" />
              <ellipse cx="16" cy="16" rx="12" ry="4.5" fill="none" stroke="var(--primary)" strokeOpacity="0.5" strokeWidth="1" transform="rotate(-18 16 16)" />
              <circle cx="26.5" cy="11.5" r="1.6" fill="var(--highlight)" />
              <defs>
                <linearGradient id="pft-orbit" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="var(--primary)" />
                  <stop offset="100%" stopColor="var(--nebula-violet)" />
                </linearGradient>
              </defs>
            </svg>
          </span>
          <span className="font-mono text-sm font-bold tracking-[0.2em] text-foreground">
            PFT <span className="text-muted-foreground">{'//'}</span> <span className="text-gradient">TERMINAL</span>
          </span>
        </Link>
        <div className="flex w-fit items-center gap-2 rounded-md border border-primary/25 bg-primary/10 px-2 py-1 font-mono text-[10px] font-medium tracking-wider text-primary">
          <span className="relative flex size-1.5" aria-hidden="true">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75 motion-reduce:animate-none" />
            <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
          </span>
          BRIDGE CONNECTED · 4ms
        </div>
      </div>

      <nav aria-label="Dashboard" className="flex-1 overflow-y-auto px-3 py-4">
        <p className="px-2 pb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Navigation</p>
        <ul className="flex flex-col gap-0.5">
          <li>
            <Link
              href={TERMINAL_NAV.href}
              aria-current={view === 'terminal' ? 'page' : undefined}
              className={cn(
                'group relative flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                view === 'terminal'
                  ? 'bg-primary/10 text-foreground shadow-[inset_0_0_0_1px_rgba(67,136,255,0.18)]'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              {view === 'terminal' && (
                <span
                  className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-linear-to-b from-primary to-nebula-violet shadow-[0_0_8px_rgba(67,136,255,0.8)]"
                  aria-hidden="true"
                />
              )}
              <TERMINAL_NAV.icon
                className={cn('size-4 shrink-0', view === 'terminal' ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')}
                aria-hidden="true"
              />
              {TERMINAL_NAV.label}
            </Link>
          </li>
          {DASHBOARD_VIEWS.map((item) => {
            const active = item.id === view
            const Icon = item.icon
            const content = (
              <>
                {active && (
                  <span
                    className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-linear-to-b from-primary to-nebula-violet shadow-[0_0_8px_rgba(67,136,255,0.8)]"
                    aria-hidden="true"
                  />
                )}
                <Icon className={cn('size-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')} aria-hidden="true" />
                {item.label}
              </>
            )
            const className = cn(
              'group relative flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
              active ? 'bg-primary/10 text-foreground shadow-[inset_0_0_0_1px_rgba(67,136,255,0.18)]' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            )
            if ('href' in item && item.href) {
              return (
                <li key={item.id}>
                  <Link href={item.href} aria-current={active ? 'page' : undefined} className={className}>
                    {content}
                  </Link>
                </li>
              )
            }
            const fallback = item as { id: DashboardView }
            const fallbackId = fallback.id
            return (
              <li key={fallbackId}>
                <button
                  type="button"
                  onClick={() => onNavigate(fallbackId)}
                  aria-current={active ? 'page' : undefined}
                  className={className}
                >
                  {content}
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="border-t border-border p-3">
        <div className="flex items-center gap-3 rounded-lg border border-border bg-background/60 p-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-primary to-highlight p-px">
            <span className="flex size-full items-center justify-center rounded-full bg-card font-mono text-xs font-semibold text-foreground">MR</span>
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">Marcus Reyes</p>
            <span className="mt-0.5 inline-flex rounded border border-highlight/30 bg-highlight/10 px-1.5 py-px font-mono text-[10px] font-medium text-highlight">
              Pro Trader
            </span>
          </div>
          <Link
            href="/"
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Log out"
          >
            <LogOut className="size-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </div>
  )
}
