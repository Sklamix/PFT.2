'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw, Search, Users, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Entry = {
  id: string
  action: string
  reason: string | null
  createdAt: string
  actor: { id: string | null; name: string | null; email: string | null; role: string | null }
  ip: string | null
  path: string | null
  method: string | null
  userAgent: string | null
  metadataExcerpt: string | null
}

type Scope = 'trader' | 'staff'

function timeLabel(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function actionLabel(action: string) {
  return action
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

function ActivityCard({
  scope,
  title,
  description,
  canView,
  deniedLabel,
}: {
  scope: Scope
  title: string
  description: string
  canView: boolean
  deniedLabel: string
}) {
  const [items, setItems] = useState<Entry[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)

  const load = useCallback(
    async (next?: string | null) => {
      if (!canView) {
        setLoading(false)
        return
      }
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({ scope, take: '50' })
        if (query.trim()) params.set('q', query.trim())
        if (next) params.set('cursor', next)
        const response = await fetch(`/api/admin/activity?${params}`, { cache: 'no-store' })
        const data = (await response.json().catch(() => ({}))) as { items?: Entry[]; nextCursor?: string | null; error?: string }
        if (!response.ok) throw new Error(data.error ?? 'Unable to load activity.')
        setItems((current) => (next ? [...current, ...(data.items ?? [])] : data.items ?? []))
        setCursor(data.nextCursor ?? null)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Unable to load activity.')
      } finally {
        setLoading(false)
      }
    },
    [canView, query, scope],
  )

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250)
    return () => window.clearTimeout(timer)
  }, [load])

  if (!canView) {
    return (
      <section className="rounded-xl border border-border bg-card">
        <header className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        </header>
        <p className="p-4 text-xs text-muted-foreground">{deniedLabel}</p>
      </section>
    )
  }

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            {scope === 'trader' ? <Users className="size-4 text-primary" /> : <ShieldCheck className="size-4 text-primary" />}
            {title}
          </h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search email, action…"
              className="h-8 w-56 rounded-md border border-border bg-background pl-7 pr-2 text-xs text-foreground outline-none focus:border-ring"
              aria-label={`Search ${title}`}
            />
          </label>
          <Button variant="outline" size="sm" className="h-8" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            Refresh
          </Button>
        </div>
      </header>

      <div className="max-h-[420px] overflow-auto">
        {error ? (
          <p className="p-4 text-xs text-destructive">{error}</p>
        ) : items.length === 0 && !loading ? (
          <p className="p-4 text-xs text-muted-foreground">No activity recorded yet.</p>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-secondary/70 backdrop-blur">
              <tr className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-2 py-2 font-medium">Actor</th>
                <th className="px-2 py-2 font-medium">Action</th>
                <th className="px-2 py-2 font-medium">Details</th>
                <th className="px-4 py-2 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {items.map((entry) => (
                <tr key={entry.id} className="border-t border-border/60 align-top">
                  <td className="whitespace-nowrap px-4 py-2 font-mono tabular-nums text-muted-foreground">{timeLabel(entry.createdAt)}</td>
                  <td className="px-2 py-2">
                    <p className="text-foreground">{entry.actor.name ?? entry.actor.email ?? 'System'}</p>
                    <p className="font-mono text-[10px] text-muted-foreground">
                      {entry.actor.role ?? '—'}
                      {entry.actor.email ? ` · ${entry.actor.email}` : ''}
                    </p>
                  </td>
                  <td className="px-2 py-2">
                    <span className={cn('rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide', entry.action.startsWith('TRADER_') ? 'bg-primary/10 text-primary' : 'bg-secondary text-foreground')}>
                      {actionLabel(entry.action)}
                    </span>
                    {entry.reason ? <p className="mt-1 max-w-56 text-[11px] text-muted-foreground">{entry.reason}</p> : null}
                  </td>
                  <td className="max-w-64 px-2 py-2 text-[11px] text-muted-foreground">
                    {entry.metadataExcerpt ?? '—'}
                    {entry.userAgent ? <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">{entry.userAgent}</p> : null}
                  </td>
                  <td className="px-4 py-2 font-mono text-[10px] text-muted-foreground">
                    <p>{entry.method ?? ''} {entry.path ?? ''}</p>
                    <p>{entry.ip ?? ''}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {cursor ? (
        <div className="border-t border-border p-3 text-center">
          <Button variant="ghost" size="sm" onClick={() => void load(cursor)} disabled={loading}>
            {loading ? 'Loading…' : 'Load older events'}
          </Button>
        </div>
      ) : null}
    </section>
  )
}

export function ActivityLog({ role }: { role: string }) {
  const isAdmin = role === 'ADMIN'
  return (
    <div className="flex flex-col gap-4">
      <ActivityCard
        scope="trader"
        title="Trader activity"
        description="What traders did, from where and when. Visible to support, risk and admins (read-only)."
        canView={['ADMIN', 'RISK_MANAGER', 'SUPPORT'].includes(role)}
        deniedLabel="Your role cannot review trader activity."
      />
      <ActivityCard
        scope="staff"
        title="Staff activity"
        description="Administrative actions with the operator, reason and request source. Admins only."
        canView={isAdmin}
        deniedLabel="Only admins can review staff activity."
      />
    </div>
  )
}
