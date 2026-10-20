'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  calculatePnlUsd,
  FOREX_MAJORS,
  formatPrice,
  getSymbol,
  pipValueUsd,
  requiredMarginUsd,
} from '@/lib/constants/symbols'
import { formatUsd } from '@/lib/dashboard-data'
import { useTerminalBook } from '@/lib/stores/useTerminalBook'
import { useTradingStore } from '@/lib/stores/useTradingStore'
import type { OrderSide } from '@/lib/types/terminal'
import { cn } from '@/lib/utils'

const LOT_PRESETS = [0.01, 0.1, 1, 5] as const

export function OrderPanel() {
  const selectedSymbol = useTradingStore((state) => state.selectedSymbol)
  const bid = useTradingStore((state) => state.bid)
  const ask = useTradingStore((state) => state.ask)
  const connectionStatus = useTradingStore((state) => state.connectionStatus)
  const placeMarket = useTerminalBook((state) => state.placeMarket)
  const placePending = useTerminalBook((state) => state.placePending)
  const accountStatus = useTerminalBook((state) => state.account?.status)
  const freeMargin = useTerminalBook((state) => state.snapshot.freeMargin)
  const leverage = useTerminalBook((state) => state.account?.leverage ?? 100)

  const [orderType, setOrderType] = useState<'market' | 'limit'>('market')
  const [side, setSide] = useState<OrderSide>('BUY')
  const [lots, setLots] = useState('0.10')
  const [stopLoss, setStopLoss] = useState('')
  const [takeProfit, setTakeProfit] = useState('')
  const [limitPrice, setLimitPrice] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const meta = getSymbol(selectedSymbol)
  const sizeLots = Number(lots)
  const sl = stopLoss === '' ? null : Number(stopLoss)
  const tp = takeProfit === '' ? null : Number(takeProfit)
  const limit = limitPrice === '' ? null : Number(limitPrice)
  const entry = side === 'BUY' ? ask : bid
  const validLots = Number.isFinite(sizeLots) && sizeLots > 0
  const pipValue = validLots ? pipValueUsd(selectedSymbol, sizeLots, entry) : 0
  const margin = validLots ? requiredMarginUsd(selectedSymbol, sizeLots, entry, leverage) : 0
  const tradable = accountStatus === 'ACTIVE' && (FOREX_MAJORS as readonly string[]).includes(selectedSymbol)

  const projections = useMemo(() => {
    if (!validLots) return { sl: null as number | null, tp: null as number | null }
    return {
      sl: sl && sl > 0 ? calculatePnlUsd(selectedSymbol, side, sizeLots, entry, sl) : null,
      tp: tp && tp > 0 ? calculatePnlUsd(selectedSymbol, side, sizeLots, entry, tp) : null,
    }
  }, [entry, selectedSymbol, side, sizeLots, sl, tp, validLots])

  const canSubmit =
    tradable &&
    connectionStatus === 'CONNECTED' &&
    validLots &&
    !busy &&
    (orderType === 'market' || (limit != null && limit > 0)) &&
    (sl == null || Number.isFinite(sl)) &&
    (tp == null || Number.isFinite(tp))

  async function execute() {
    if (!canSubmit) return
    setBusy(true)
    setNotice(null)
    try {
      if (orderType === 'limit' && limit) {
        const result = await placePending({
          symbol: selectedSymbol,
          side,
          sizeLots,
          limitPrice: limit,
          stopLoss: sl,
          takeProfit: tp,
        })
        setNotice(
          result.ok
            ? { tone: 'ok', text: `Limit ${side} ${sizeLots} ${meta.displayName} queued at ${formatPrice(selectedSymbol, limit)}` }
            : { tone: 'error', text: result.error },
        )
      } else {
        const result = await placeMarket({
          symbol: selectedSymbol,
          side,
          sizeLots,
          stopLoss: sl,
          takeProfit: tp,
        })
        setNotice(
          result.ok
            ? { tone: 'ok', text: `Filled ${side} ${sizeLots} ${meta.displayName} @ ${formatPrice(selectedSymbol, result.position.entryPrice)}` }
            : { tone: 'error', text: result.error },
        )
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="flex w-full shrink-0 flex-col rounded-xl border border-border bg-card lg:w-80">
      <div className="border-b border-border px-4 py-3">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Order ticket</p>
        <p className="mt-1 text-sm font-medium text-foreground">{meta.name}</p>
      </div>

      <div className="flex flex-1 flex-col gap-4 p-4">
        <Tabs value={orderType} onValueChange={(value) => setOrderType(value === 'limit' ? 'limit' : 'market')}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="market">Market</TabsTrigger>
            <TabsTrigger value="limit">Pending / Limit</TabsTrigger>
          </TabsList>
          <TabsContent value="market" className="mt-3 text-xs text-muted-foreground">
            Live Twelve Data price with an indicative spread; not executable broker bid/ask.
          </TabsContent>
          <TabsContent value="limit" className="mt-3 space-y-2">
            <Field label="Limit price">
              <input
                inputMode="decimal"
                value={limitPrice}
                onChange={(event) => setLimitPrice(event.target.value)}
                placeholder={formatPrice(selectedSymbol, entry)}
                className={inputClass}
              />
            </Field>
          </TabsContent>
        </Tabs>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setSide('BUY')}
            className={cn(
              'rounded-lg border px-3 py-2.5 text-left transition-colors',
              side === 'BUY'
                ? 'border-primary/50 bg-primary/15 text-primary'
                : 'border-border bg-secondary/40 text-muted-foreground hover:text-foreground',
            )}
          >
            <span className="block font-mono text-[10px] uppercase tracking-widest">Buy / Ask</span>
            <span className="font-mono text-lg font-semibold tabular-nums text-primary">{formatPrice(selectedSymbol, ask)}</span>
          </button>
          <button
            type="button"
            onClick={() => setSide('SELL')}
            className={cn(
              'rounded-lg border px-3 py-2.5 text-left transition-colors',
              side === 'SELL'
                ? 'border-danger/50 bg-danger/15 text-danger'
                : 'border-border bg-secondary/40 text-muted-foreground hover:text-foreground',
            )}
          >
            <span className="block font-mono text-[10px] uppercase tracking-widest">Sell / Bid</span>
            <span className="font-mono text-lg font-semibold tabular-nums text-danger">{formatPrice(selectedSymbol, bid)}</span>
          </button>
        </div>

        <Field label="Lot size">
          <input
            inputMode="decimal"
            value={lots}
            onChange={(event) => setLots(event.target.value)}
            className={inputClass}
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {LOT_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setLots(preset.toFixed(2))}
                className={cn(
                  'rounded-full border px-2 py-0.5 font-mono text-[11px]',
                  Number(lots) === preset
                    ? 'border-primary/40 bg-primary/15 text-primary'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {preset.toFixed(2)}
              </button>
            ))}
          </div>
          <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
            ~{formatUsd(pipValue)} / pip · margin {formatUsd(margin)}
          </p>
          {validLots && margin > freeMargin ? (
            <p className="mt-1 font-mono text-[11px] text-danger">Exceeds free margin {formatUsd(freeMargin)}</p>
          ) : null}
        </Field>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Stop loss">
            <input inputMode="decimal" value={stopLoss} onChange={(event) => setStopLoss(event.target.value)} placeholder="Optional" className={inputClass} />
            {projections.sl != null && (
              <p className={cn('mt-1 font-mono text-[11px]', projections.sl >= 0 ? 'text-primary' : 'text-danger')}>
                {formatUsd(projections.sl, { signed: true })}
              </p>
            )}
          </Field>
          <Field label="Take profit">
            <input inputMode="decimal" value={takeProfit} onChange={(event) => setTakeProfit(event.target.value)} placeholder="Optional" className={inputClass} />
            {projections.tp != null && (
              <p className={cn('mt-1 font-mono text-[11px]', projections.tp >= 0 ? 'text-primary' : 'text-danger')}>
                {formatUsd(projections.tp, { signed: true })}
              </p>
            )}
          </Field>
        </div>

        <Button className="mt-auto h-10 w-full" disabled={!canSubmit} onClick={() => void execute()}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          {busy ? 'Working…' : orderType === 'limit' ? 'Place limit order' : 'Execute trade'}
        </Button>
        {!tradable && accountStatus ? (
          <p className="font-mono text-[11px] text-muted-foreground">
            {accountStatus !== 'ACTIVE' ? `Account ${accountStatus.toLowerCase()} — orders disabled` : 'Symbol not tradable on this account'}
          </p>
        ) : null}
        {tradable && connectionStatus !== 'CONNECTED' ? (
          <p className="font-mono text-[11px] text-warning">Waiting for a fresh OANDA quote — orders disabled</p>
        ) : null}
        {notice ? (
          <p role={notice.tone === 'error' ? 'alert' : 'status'} className={cn('font-mono text-[11px]', notice.tone === 'error' ? 'text-danger' : 'text-highlight')}>
            {notice.text}
          </p>
        ) : null}
      </div>
    </aside>
  )
}

const inputClass =
  'h-8 w-full rounded-md border border-input bg-background/70 px-2 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}
