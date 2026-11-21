'use client'

import { useState } from 'react'
import { Activity, Database, Loader2, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type NvidiaResult = {
  ok: boolean
  provider: string
  model: string
  endpointHost: string | null
  httpStatus: number | null
  latencyMs: number
  checkedAt: string
  schemaValid: boolean | null
  category: string | null
  resolved: boolean | null
  error: { category: string; status: number | null } | null
}

type DbResult = {
  status: 'TEST' | 'PRODUCTION' | 'BLOCKED'
  environment: string
  hostname: string | null
  databaseName: string | null
  runtimeDatabaseName: string | null
  isApprovedTestDatabase: boolean
  isProductionDatabase: boolean
  identityVerified: boolean
  reason: string | null
  checkedAt: string
  queryError: string | null
}

async function postJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error((data as { error?: string }).error || `Request failed (${response.status})`)
  return data as T
}

function Field({ label, value }: { label: string; value: string | number | boolean | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1 text-xs last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-mono text-foreground">{value === null ? '—' : String(value)}</span>
    </div>
  )
}

function badgeClass(ok: boolean, warn = false) {
  if (ok) return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
  return warn ? 'border-warning/40 bg-warning/10 text-warning' : 'border-danger/40 bg-danger/10 text-danger'
}

/**
 * ADMIN-only diagnostics. Both actions are POST-only, same-origin, and never
 * create support records or change any business data.
 */
export function DiagnosticsPanel() {
  const [nvidia, setNvidia] = useState<NvidiaResult | null>(null)
  const [db, setDb] = useState<DbResult | null>(null)
  const [loading, setLoading] = useState<'nvidia' | 'db' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run(kind: 'nvidia' | 'db') {
    if (loading) return
    setLoading(kind)
    setError(null)
    try {
      if (kind === 'nvidia') setNvidia(await postJson<NvidiaResult>('/api/admin/diagnostics/nvidia'))
      else setDb(await postJson<DbResult>('/api/admin/diagnostics/database'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Diagnostics failed.')
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Activity className="size-4 text-primary" /> NVIDIA runtime status
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">Live synthetic probe through the production adapter. No ticket is created.</p>
          </div>
          <Button size="sm" variant="outline" disabled={loading !== null} onClick={() => void run('nvidia')}>
            {loading === 'nvidia' ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
            Run probe
          </Button>
        </div>
        {nvidia ? (
          <div className="mt-3">
            <span className={cn('inline-flex rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase', badgeClass(nvidia.ok))}>
              {nvidia.ok ? 'PASS' : 'FAIL'}
            </span>
            <Field label="Provider" value={nvidia.provider} />
            <Field label="Model" value={nvidia.model} />
            <Field label="Endpoint host" value={nvidia.endpointHost} />
            <Field label="HTTP status" value={nvidia.httpStatus} />
            <Field label="Latency (ms)" value={nvidia.latencyMs} />
            <Field label="Schema valid" value={nvidia.schemaValid} />
            <Field label="Error category" value={nvidia.error?.category ?? null} />
            <Field label="Checked at" value={nvidia.checkedAt} />
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">Not run yet.</p>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Database className="size-4 text-highlight" /> Preview database identity
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">Read-only SELECT. Never returns the connection URL or credentials.</p>
          </div>
          <Button size="sm" variant="outline" disabled={loading !== null} onClick={() => void run('db')}>
            {loading === 'db' ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
            Check database
          </Button>
        </div>
        {db ? (
          <div className="mt-3">
            <span className={cn('inline-flex rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase', badgeClass(db.status === 'TEST', db.status === 'BLOCKED'))}>
              {db.status}
            </span>
            <Field label="Environment" value={db.environment} />
            <Field label="Hostname" value={db.hostname} />
            <Field label="Database name" value={db.databaseName} />
            <Field label="Live current_database()" value={db.runtimeDatabaseName} />
            <Field label="Approved test DB" value={db.isApprovedTestDatabase} />
            <Field label="Production DB" value={db.isProductionDatabase} />
            <Field label="Identity verified" value={db.identityVerified} />
            <Field label="Reason" value={db.reason} />
            <Field label="Checked at" value={db.checkedAt} />
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">Not run yet.</p>
        )}
      </section>

      {error ? <p role="alert" className="lg:col-span-2 text-xs text-danger">{error}</p> : null}
    </div>
  )
}
