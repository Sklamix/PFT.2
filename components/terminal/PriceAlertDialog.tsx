'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatPrice, getSymbol, isTerminalSymbol } from '@/lib/constants/symbols'
import { useTraderMe } from '@/hooks/use-trader-me'
import { cn } from '@/lib/utils'

type PriceAlertDialogProps = {
  open: boolean
  onClose: () => void
  symbol: string
  price: number
  onCreate: (symbol: string, direction: 'ABOVE' | 'BELOW', price: number) => void
}

const DIRECTIONS: { value: 'ABOVE' | 'BELOW'; label: string }[] = [
  { value: 'ABOVE', label: 'Above' },
  { value: 'BELOW', label: 'Below' },
]

function directionLabel(value: 'ABOVE' | 'BELOW') {
  return DIRECTIONS.find((item) => item.value === value)?.label ?? value
}

export function PriceAlertDialog({ open, onClose, symbol, price, onCreate }: PriceAlertDialogProps) {
  const trader = useTraderMe()
  const [formSymbol, setFormSymbol] = useState<string>(symbol)
  const [formPrice, setFormPrice] = useState<string>(String(price))
  const [direction, setDirection] = useState<'ABOVE' | 'BELOW'>('ABOVE')
  const [alerts, setAlerts] = useState<Array<{ id: string; price: number; direction: string; createdAt: string }>>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const priceInputRef = useRef<HTMLInputElement>(null)

  const meta = isTerminalSymbol(formSymbol) ? getSymbol(formSymbol) : getSymbol('EURUSD')
  const decimals = meta.priceDecimals

  async function loadAlerts() {
    try {
      const response = await fetch(`/api/trading/alerts?symbol=${encodeURIComponent(formSymbol)}`, {
        cache: 'no-store',
      })
      if (!response.ok) return
      const data = (await response.json().catch(() => ({}))) as { alerts?: unknown[] } | null
      const rows = Array.isArray(data?.alerts) ? data.alerts : []
      setAlerts(
        rows
          .filter(
            (row): row is { id: string; price: number; direction: string; createdAt: string } =>
              typeof row === 'object' &&
              row !== null &&
              typeof (row as { id?: unknown }).id === 'string' &&
              typeof (row as { price?: unknown }).price === 'number' &&
              typeof (row as { direction?: unknown }).direction === 'string' &&
              typeof (row as { createdAt?: unknown }).createdAt === 'string',
          )
          .sort(
            (a, b) =>
              new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
          ),
      )
    } catch {
      // Alerts list is a convenience; failing to load it must not block creating one.
    }
  }

  // Load active alerts for this symbol when the dialog opens.
  useEffect(() => {
    if (!open) return
    setFormSymbol(symbol)
    setFormPrice(price.toFixed(decimals))
    setDirection('ABOVE')
    setError(null)
    void loadAlerts()
  }, [open, symbol, price, decimals, loadAlerts])

  async function cancelAlert(id: string) {
    setError(null)
    const response = await fetch(`/api/trading/alerts/${id}`, { method: 'DELETE' })
    if (!response.ok) {
      setError('Unable to cancel that alert. Try again.')
      return
    }
    await loadAlerts()
  }

  function priceIsValid(value: string): boolean {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) return false
    const rounded = Number(parsed.toFixed(decimals))
    return Math.abs(parsed - rounded) < 1e-9
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (!priceIsValid(formPrice)) {
      setError(`Price must use ${decimals} decimal place${decimals === 1 ? '' : 's'} for ${formSymbol}.`)
      return
    }
    const parsed = Number(formPrice)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Enter a valid price.')
      return
    }
    setBusy(true)
    try {
      const response = await fetch('/api/trading/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: formSymbol, price: parsed, direction }),
      })
      const data = (await response.json().catch(() => ({}))) as { error?: string; alert?: unknown } | null
      if (!response.ok || !data) {
        setError(data?.error || 'Unable to create the alert. Try again.')
        return
      }
      onCreate(formSymbol, direction, parsed)
      onClose()
    } catch {
      setError('Unable to create the alert. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const email = trader?.email ?? 'your account email'

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-sm p-0">
        <DialogHeader>
          <DialogTitle>Notify me at a level</DialogTitle>
          <DialogDescription>
            We will email you when {formSymbol} crosses the price you set.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="p-4 space-y-4">
          <div className="flex flex-col gap-2">
            <label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              Symbol
            </label>
            <input
              readOnly
              value={formSymbol}
              className="h-8 rounded-md border border-border bg-secondary/60 px-2 font-mono text-[11px] text-foreground outline-none"
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              Price
            </label>
            <input
              ref={priceInputRef}
              type="number"
              step={String(10 ** -decimals)}
              value={formPrice}
              onChange={(event) => setFormPrice(event.target.value)}
              disabled={busy}
              className="h-8 rounded-md border border-border bg-secondary/60 px-2 font-mono tabular-nums text-[11px] text-foreground outline-none focus-visible:border-ring disabled:opacity-50"
              aria-invalid={error !== null && !priceIsValid(formPrice)}
            />
            <p className="text-[10px] text-muted-foreground">
              Example: {formatPrice(formSymbol, meta.mockBasePrice)} · {decimals} decimal place{decimals === 1 ? '' : 's'}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              Direction
            </label>
            <div className="flex gap-1">
              {DIRECTIONS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  role="radio"
                  aria-checked={direction === item.value}
                  onClick={() => setDirection(item.value)}
                  disabled={busy}
                  className={cn(
                    'flex-1 rounded-md border px-2 py-1.5 font-mono text-[11px] text-sm outline-none',
                    direction === item.value
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-secondary/60 text-foreground hover:bg-secondary/80',
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>We will email you at</span>
            <span className="font-mono text-foreground">{email}</span>
          </div>

          {error ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/50 p-2.5 text-xs text-muted-foreground">
            <span className="font-mono">Active alerts for {formSymbol}</span>
            {alerts.length === 0 ? (
              <span>None yet.</span>
            ) : (
              <span className="ml-2">({alerts.length})</span>
            )}
          </div>

          <div className="space-y-1.5">
            {alerts.map((alert) => (
              <div
                key={alert.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border bg-[#0b1122]/60 px-2.5 py-1.5"
              >
                <span className="flex items-center gap-1.5 text-xs font-mono text-foreground">
                  {formatPrice(formSymbol, alert.price)}
                  <span className="text-muted-foreground/70">{directionLabel(alert.direction as 'ABOVE' | 'BELOW')}</span>
                </span>
                <button
                  type="button"
                  onClick={() => void cancelAlert(alert.id)}
                  disabled={busy}
                  className="shrink-0 p-1 text-muted-foreground hover:text-danger"
                  aria-label={`Cancel alert at ${formatPrice(formSymbol, alert.price)}`}
                >
                  <span className="text-[10px]">✕</span>
                </button>
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || !priceIsValid(formPrice)}
              className="ml-auto"
            >
              {busy ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  Creating…
                </span>
              ) : (
                'Create alert'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
