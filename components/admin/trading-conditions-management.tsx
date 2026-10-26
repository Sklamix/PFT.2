'use client'

import { useCallback, useEffect, useState } from 'react'
import { Activity, RefreshCw, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ExecutionMetrics, MarketConditionsPayload, TradingCondition } from '@/lib/market/conditions-types'

const fieldClass =
  'h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/20'

function formatUpdated(value: string) {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

export function TradingConditionsManagement({ canManage }: { canManage: boolean }) {
  const [instruments, setInstruments] = useState<TradingCondition[]>([])
  const [metrics, setMetrics] = useState<ExecutionMetrics | null>(null)
  const [speed, setSpeed] = useState('28')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const applyPayload = useCallback((payload: MarketConditionsPayload) => {
    setInstruments(payload.instruments)
    setMetrics(payload.metrics)
    setSpeed(String(payload.metrics.avgExecutionSpeedMs))
  }, [])

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/trading-conditions', { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Unable to load trading conditions')
      applyPayload(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load trading conditions')
    } finally {
      setLoading(false)
    }
  }, [applyPayload])

  useEffect(() => {
    void load()
  }, [load])

  function updateInstrument(id: string, patch: Partial<TradingCondition>) {
    setInstruments((current) => current.map((instrument) => (instrument.id === id ? { ...instrument, ...patch } : instrument)))
  }

  async function save() {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch('/api/admin/trading-conditions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          avgExecutionSpeedMs: Number(speed),
          instruments: instruments.map((instrument) => ({
            id: instrument.id,
            avgSpread: Number(instrument.avgSpread),
            commissionPerLot: Number(instrument.commissionPerLot),
            isActive: instrument.isActive,
          })),
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Unable to save trading conditions')
      applyPayload(data)
      setNotice('Trading conditions updated.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save trading conditions')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <Activity className="size-4 text-primary" />
            Trading conditions
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Homepage instruments, average spreads and execution speed.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {metrics && (
            <span className="font-mono text-[10px] text-muted-foreground">
              Updated {formatUpdated(metrics.lastUpdated)}
            </span>
          )}
          <Button size="xs" variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? 'animate-spin' : undefined} />
            Refresh
          </Button>
          {canManage && (
            <Button size="xs" onClick={() => void save()} disabled={saving || loading}>
              {saving ? <RefreshCw className="animate-spin" /> : <Save />}
              Save conditions
            </Button>
          )}
        </div>
      </div>

      {error && (
        <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
      )}
      {notice && (
        <p className="mt-3 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-primary">{notice}</p>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-background p-3">
        <label className="grid w-48 gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
          Execution speed
          <span className="flex items-center gap-2">
            <input
              type="number"
              min="0"
              max="10000"
              value={speed}
              onChange={(event) => setSpeed(event.target.value)}
              disabled={!canManage}
              className={fieldClass}
            />
            <span className="font-mono text-xs normal-case text-foreground">ms</span>
          </span>
        </label>
        <p className="pb-1 text-xs text-muted-foreground">
          Used by the homepage “avg. XXms” badge. Update from your bridge or manually.
        </p>
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[620px] text-left text-xs">
          <thead className="bg-background text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Instrument</th>
              <th scope="col" className="px-3 py-2 font-medium">Category</th>
              <th scope="col" className="px-3 py-2 font-medium">Avg. spread (24h)</th>
              <th scope="col" className="px-3 py-2 font-medium">Commission / lot</th>
              <th scope="col" className="px-3 py-2 text-center font-medium">Active</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">Loading trading conditions…</td>
              </tr>
            )}
            {!loading && instruments.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No instruments configured.</td>
              </tr>
            )}
            {!loading && instruments.map((instrument) => (
              <tr key={instrument.id}>
                <td className="px-3 py-2.5 font-mono font-medium">{instrument.symbol}</td>
                <td className="px-3 py-2.5 text-muted-foreground">{instrument.category}</td>
                <td className="px-3 py-2.5">
                  <input
                    type="number"
                    min="0"
                    step="0.001"
                    value={instrument.avgSpread}
                    onChange={(event) => updateInstrument(instrument.id, { avgSpread: Number(event.target.value) })}
                    disabled={!canManage}
                    aria-label={`${instrument.symbol} average spread`}
                    className={fieldClass}
                  />
                </td>
                <td className="px-3 py-2.5">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={instrument.commissionPerLot}
                    onChange={(event) => updateInstrument(instrument.id, { commissionPerLot: Number(event.target.value) })}
                    disabled={!canManage}
                    aria-label={`${instrument.symbol} commission per lot`}
                    className={fieldClass}
                  />
                </td>
                <td className="px-3 py-2.5 text-center">
                  <input
                    type="checkbox"
                    checked={instrument.isActive}
                    onChange={(event) => updateInstrument(instrument.id, { isActive: event.target.checked })}
                    disabled={!canManage}
                    aria-label={`${instrument.symbol} active on homepage`}
                    className="size-4 accent-primary"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[10px] text-muted-foreground">
        The 24h average is recalculated from live terminal spreads every 10 minutes. Manual values are used until samples arrive.
      </p>
    </section>
  )
}
