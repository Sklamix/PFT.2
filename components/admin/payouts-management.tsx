'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Loader2, Plus, RefreshCw, Trash2, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { PublicPayout, PublicStatsPayload } from '@/lib/stats/types'

const fieldClass =
  'h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/50 focus:ring-2 focus:ring-primary/20'

const numberFormat = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

const compactFormat = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value))
}

const emptyForm = {
  traderName: '',
  countryCode: '',
  accountSize: '',
  payoutAmount: '',
  payoutMethod: 'USDT',
  createdAt: '',
}

export function PayoutsManagement({ canManage }: { canManage: boolean }) {
  const [items, setItems] = useState<PublicPayout[]>([])
  const [stats, setStats] = useState<PublicStatsPayload['stats'] | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [proofsResponse, statsResponse] = await Promise.all([
        fetch('/api/admin/payout-proofs', { cache: 'no-store' }),
        fetch('/api/stats', { cache: 'no-store' }),
      ])
      const proofs = await proofsResponse.json().catch(() => ({}))
      const statsPayload = await statsResponse.json().catch(() => ({}))
      if (!proofsResponse.ok) throw new Error(proofs.error || 'Unable to load payout proofs')
      setItems(Array.isArray(proofs.items) ? proofs.items : [])
      if (statsResponse.ok && statsPayload.stats) setStats(statsPayload.stats)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load payout proofs')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const interval = window.setInterval(() => void load(), 60_000)
    return () => window.clearInterval(interval)
  }, [load])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch('/api/admin/payout-proofs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          accountSize: Number(form.accountSize),
          payoutAmount: Number(form.payoutAmount),
          createdAt: form.createdAt || undefined,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Unable to save payout proof')
      setOpen(false)
      setForm(emptyForm)
      setNotice('Payout recorded. Public counters updated.')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save payout proof')
    } finally {
      setSaving(false)
    }
  }

  async function remove(id: string) {
    if (!window.confirm('Delete this payout proof and subtract it from the public total?')) return
    try {
      const response = await fetch(`/api/admin/payout-proofs/${id}`, { method: 'DELETE' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Unable to delete payout proof')
      setNotice('Payout proof removed.')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete payout proof')
    }
  }

  async function recalculate() {
    try {
      setError(null)
      setNotice(null)
      const response = await fetch('/api/stats/recalculate', { method: 'POST' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Unable to recalculate stats')
      setNotice('Platform stats recalculated.')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to recalculate stats')
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <Wallet className="size-4 text-primary" />
            Payouts management
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Public payout proof feed and homepage reward counters.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="xs" variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? 'animate-spin' : undefined} />
            Refresh
          </Button>
          {canManage && (
            <Button size="xs" variant="outline" onClick={() => void recalculate()}>
              Recalculate stats
            </Button>
          )}
          {canManage && (
            <Button size="xs" onClick={() => setOpen(true)}>
              <Plus />
              Record payout
            </Button>
          )}
        </div>
      </div>

      {stats && (
        <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ['Total rewards', numberFormat.format(stats.totalRewardsPaid)],
            ['Funded traders', stats.fundedTradersCount.toLocaleString('en-US')],
            ['Avg. payout', `${stats.avgPayoutTimeHours} hrs`],
            ['Countries', stats.countriesServedCount.toString()],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-border bg-background px-3 py-2.5">
              <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</dt>
              <dd className="mt-1 font-mono text-lg font-semibold tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {error && (
        <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
      )}
      {notice && (
        <p className="mt-3 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-primary">{notice}</p>
      )}

      <div className="mt-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[620px] text-left text-xs">
          <thead className="bg-background text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Trader</th>
              <th scope="col" className="px-3 py-2 font-medium">Account</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Payout</th>
              <th scope="col" className="px-3 py-2 font-medium">Method</th>
              <th scope="col" className="px-3 py-2 font-medium">Date</th>
              {canManage && <th scope="col" className="px-3 py-2 text-right font-medium">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && (
              <tr>
                <td colSpan={canManage ? 6 : 5} className="px-3 py-6 text-center text-muted-foreground">Loading payout proofs…</td>
              </tr>
            )}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={canManage ? 6 : 5} className="px-3 py-6 text-center text-muted-foreground">No payout proofs yet.</td>
              </tr>
            )}
            {!loading && items.map((item) => (
              <tr key={item.id}>
                <td className="px-3 py-2.5">
                  <span className="font-medium">{item.traderName}</span>
                  <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{item.countryCode}</span>
                </td>
                <td className="px-3 py-2.5 font-mono text-muted-foreground">${compactFormat.format(item.accountSize)}</td>
                <td className="px-3 py-2.5 text-right font-mono font-semibold text-primary">{numberFormat.format(item.payoutAmount)}</td>
                <td className="px-3 py-2.5 text-muted-foreground">{item.payoutMethod}</td>
                <td className="px-3 py-2.5 text-muted-foreground">{formatDate(item.createdAt)}</td>
                {canManage && (
                  <td className="px-3 py-2.5 text-right">
                    <Button size="icon-xs" variant="ghost" aria-label={`Delete ${item.traderName}'s payout`} onClick={() => void remove(item.id)}>
                      <Trash2 />
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="border-border bg-card sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Record payout proof</DialogTitle>
            <DialogDescription>
              Adds a verified public payout and increases the homepage total rewards counter.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5 text-xs">
                <span className="text-muted-foreground">Trader name</span>
                <input
                  required
                  value={form.traderName}
                  onChange={(event) => setForm((current) => ({ ...current, traderName: event.target.value }))}
                  className={fieldClass}
                  placeholder="Priya N."
                />
              </label>
              <label className="grid gap-1.5 text-xs">
                <span className="text-muted-foreground">Country code</span>
                <input
                  required
                  maxLength={2}
                  value={form.countryCode}
                  onChange={(event) => setForm((current) => ({ ...current, countryCode: event.target.value.toUpperCase() }))}
                  className={fieldClass}
                  placeholder="IN"
                />
              </label>
              <label className="grid gap-1.5 text-xs">
                <span className="text-muted-foreground">Account size (USD)</span>
                <input
                  required
                  type="number"
                  min="1"
                  step="0.01"
                  value={form.accountSize}
                  onChange={(event) => setForm((current) => ({ ...current, accountSize: event.target.value }))}
                  className={fieldClass}
                  placeholder="25000"
                />
              </label>
              <label className="grid gap-1.5 text-xs">
                <span className="text-muted-foreground">Payout amount (USD)</span>
                <input
                  required
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={form.payoutAmount}
                  onChange={(event) => setForm((current) => ({ ...current, payoutAmount: event.target.value }))}
                  className={fieldClass}
                  placeholder="2870"
                />
              </label>
              <label className="grid gap-1.5 text-xs">
                <span className="text-muted-foreground">Method</span>
                <input
                  required
                  list="payout-proof-methods"
                  value={form.payoutMethod}
                  onChange={(event) => setForm((current) => ({ ...current, payoutMethod: event.target.value }))}
                  className={fieldClass}
                  placeholder="USDT"
                />
                <datalist id="payout-proof-methods">
                  <option value="USDT" />
                  <option value="USDC" />
                  <option value="Bank Wire" />
                </datalist>
              </label>
              <label className="grid gap-1.5 text-xs">
                <span className="text-muted-foreground">Date (optional)</span>
                <input
                  type="datetime-local"
                  value={form.createdAt}
                  onChange={(event) => setForm((current) => ({ ...current, createdAt: event.target.value }))}
                  className={fieldClass}
                />
              </label>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="animate-spin" />}
                Save payout
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  )
}
