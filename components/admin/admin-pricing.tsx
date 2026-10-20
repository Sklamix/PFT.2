'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

type PricingTab = '1-STEP' | '2-STEP'
type OneStepRow = { accountSize: number; price: number }
type TwoStepRow = { accountSize: number; price3: number; price5: number }

const SIZES = [1_000, 3_000, 5_000, 10_000, 25_000]
const CURRENCY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

export function AdminPricing({ email }: { email: string }) {
  const [activeTab, setActiveTab] = useState<PricingTab>('2-STEP')
  const [oneStepRows, setOneStepRows] = useState<OneStepRow[]>([])
  const [twoStepRows, setTwoStepRows] = useState<TwoStepRow[]>([])
  const [markup, setMarkup] = useState('36')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    fetch('/api/pricing', { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Unable to load prices.')
        const oneStep = new Map<number, OneStepRow>()
        const twoStep = new Map<number, TwoStepRow>()
        for (const item of data.prices as Array<{
          accountSize: number
          challengeType: PricingTab
          dailyLossType: number
          price: number
        }>) {
          if (item.challengeType === '1-STEP' && item.dailyLossType === 4) {
            oneStep.set(item.accountSize, { accountSize: item.accountSize, price: item.price })
          } else if (item.challengeType === '2-STEP' && (item.dailyLossType === 3 || item.dailyLossType === 5)) {
            const row = twoStep.get(item.accountSize) ?? { accountSize: item.accountSize, price3: 0, price5: 0 }
            if (item.dailyLossType === 3) row.price3 = item.price
            else row.price5 = item.price
            twoStep.set(item.accountSize, row)
          }
        }
        if (active) {
          setOneStepRows(SIZES.map((size) => oneStep.get(size) ?? { accountSize: size, price: 0 }))
          setTwoStepRows(SIZES.map((size) => twoStep.get(size) ?? { accountSize: size, price3: 0, price5: 0 }))
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Unable to load prices.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  function updateOneStepPrice(accountSize: number, value: string) {
    const price = value === '' ? 0 : Number(value)
    setOneStepRows((current) => current.map((row) => row.accountSize === accountSize ? { ...row, price } : row))
  }

  function updateTwoStepPrice(accountSize: number, field: 'price3' | 'price5', value: string) {
    const price = value === '' ? 0 : Number(value)
    setTwoStepRows((current) => current.map((row) => row.accountSize === accountSize ? { ...row, [field]: price } : row))
  }

  function recalculatePremium() {
    const percent = Number(markup)
    if (!Number.isFinite(percent) || percent < 0 || percent > 500) {
      setError('Markup must be between 0% and 500%.')
      return
    }
    setError(null)
    setTwoStepRows((current) => current.map((row) => ({ ...row, price5: Math.round(row.price3 * (1 + percent / 100)) })))
  }

  async function save() {
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      const response = await fetch('/api/admin/pricing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeType: activeTab,
          prices: activeTab === '1-STEP' ? oneStepRows : twoStepRows,
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to save prices.')
      setMessage(`${activeTab === '1-STEP' ? '1-Step' : '2-Step'} prices saved.`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save prices.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="mx-auto min-h-dvh w-full max-w-5xl px-4 py-8 text-foreground sm:px-6">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
        <div>
          <Link href="/admin" className="text-sm text-primary hover:underline">← Operations Desk</Link>
          <h1 className="mt-3 text-2xl font-semibold">Challenge pricing</h1>
          <p className="mt-1 text-sm text-muted-foreground">Signed in as {email}. Each challenge type is saved independently.</p>
        </div>
      </header>

      <section className="rounded-xl border border-border bg-card p-5 sm:p-6">
        <div className="mb-6 flex gap-2" role="tablist" aria-label="Challenge pricing type">
          {(['1-STEP', '2-STEP'] as const).map((tab) => (
            <button
              key={tab}
              id={`pricing-tab-${tab}`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              aria-controls="pricing-panel"
              onClick={() => {
                setActiveTab(tab)
                setError(null)
                setMessage(null)
              }}
              className={`rounded-md border px-4 py-2 text-sm ${activeTab === tab ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent'}`}
            >
              {tab === '1-STEP' ? '1-Step · 4% daily loss' : '2-Step · 3% / 5% daily loss'}
            </button>
          ))}
        </div>

        <div id="pricing-panel" role="tabpanel" aria-labelledby={`pricing-tab-${activeTab}`}>
          {activeTab === '2-STEP' && (
            <div className="mb-5 flex flex-wrap items-end gap-3">
              <label className="grid gap-1.5 text-sm">
                Markup for 5% Daily Loss
                <span className="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    max="500"
                    step="1"
                    value={markup}
                    onChange={(event) => setMarkup(event.target.value)}
                    className="h-10 w-28 rounded-md border border-border bg-background px-3 font-mono"
                  />
                  <span>%</span>
                </span>
              </label>
              <button
                type="button"
                onClick={recalculatePremium}
                disabled={loading || twoStepRows.length === 0}
                className="h-10 rounded-md border border-border px-4 text-sm hover:bg-accent disabled:opacity-50"
              >
                Recalculate 5% prices
              </button>
              <p className="text-xs text-muted-foreground">Rounded to whole dollars. Both columns can be edited manually.</p>
            </div>
          )}

          {loading ? <p className="py-8 text-sm text-muted-foreground">Loading prices…</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-left text-sm">
                <thead className="border-b border-border text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="pb-3 font-medium">Account size</th>
                    {activeTab === '1-STEP' ? (
                      <th className="pb-3 font-medium">Price · 4% Daily Loss</th>
                    ) : (
                      <>
                        <th className="pb-3 font-medium">3% Daily Loss</th>
                        <th className="pb-3 font-medium">5% Daily Loss</th>
                        <th className="pb-3 font-medium">Difference</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {activeTab === '1-STEP'
                    ? oneStepRows.map((row) => (
                        <tr key={row.accountSize}>
                          <th className="py-3 font-mono font-medium">{CURRENCY.format(row.accountSize)}</th>
                          <td className="py-3">
                            <label className="sr-only">1-Step 4% price for {row.accountSize}</label>
                            <input
                              type="number"
                              min="1"
                              step="1"
                              value={row.price || ''}
                              onChange={(event) => updateOneStepPrice(row.accountSize, event.target.value)}
                              className="h-9 w-28 rounded-md border border-border bg-background px-3 font-mono"
                            />
                          </td>
                        </tr>
                      ))
                    : twoStepRows.map((row) => (
                        <tr key={row.accountSize}>
                          <th className="py-3 font-mono font-medium">{CURRENCY.format(row.accountSize)}</th>
                          {(['price3', 'price5'] as const).map((field) => (
                            <td key={field} className="py-3">
                              <label className="sr-only">2-Step {field === 'price3' ? '3%' : '5%'} price for {row.accountSize}</label>
                              <input
                                type="number"
                                min="1"
                                step="1"
                                value={row[field] || ''}
                                onChange={(event) => updateTwoStepPrice(row.accountSize, field, event.target.value)}
                                className="h-9 w-28 rounded-md border border-border bg-background px-3 font-mono"
                              />
                            </td>
                          ))}
                          <td className="py-3 font-mono text-muted-foreground">{CURRENCY.format(row.price5 - row.price3)}</td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
        {message && <p role="status" className="mt-4 text-sm text-primary">{message}</p>}
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || loading || (activeTab === '1-STEP' ? oneStepRows.length === 0 : twoStepRows.length === 0)}
            className="h-10 rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : `Save ${activeTab === '1-STEP' ? '1-Step' : '2-Step'} prices`}
          </button>
        </div>
      </section>
    </main>
  )
}
