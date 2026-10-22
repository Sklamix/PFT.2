'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  calculatePnlUsd,
  formatPrice,
  getSymbol,
  lotsForMarginUsd,
  pipValueUsd,
  requiredMarginUsd,
} from '@/lib/constants/symbols'
import { formatUsd } from '@/lib/dashboard-data'
import { useTerminalBook } from '@/lib/stores/useTerminalBook'
import { useTradingStore } from '@/lib/stores/useTradingStore'
import type { OrderSide } from '@/lib/types/terminal'
import { cn } from '@/lib/utils'

const LOT_PRESETS = [0.01, 0.1, 1, 5] as const
const USD_PRESETS = [100, 500, 1000, 5000] as const
const SIZE_MODE_KEY = 'pft_order_size_mode'
const MIN_ORDER_LOTS = 0.01
const MAX_ORDER_LOTS = 50

type SizeMode = 'lots' | 'usd'

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
  const [pendingType, setPendingType] = useState<'LIMIT' | 'STOP' | 'STOP_LIMIT'>('LIMIT')
  const [side, setSide] = useState<OrderSide>('BUY')
  const [sizeMode, setSizeMode] = useState<SizeMode>('lots')
  const [lots, setLots] = useState('0.10')
  const [usdAmount, setUsdAmount] = useState('500')
  const [stopLoss, setStopLoss] = useState('')
  const [takeProfit, setTakeProfit] = useState('')
  const [limitPrice, setLimitPrice] = useState('')
  const [stopPrice, setStopPrice] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SIZE_MODE_KEY)
      if (stored === 'lots' || stored === 'usd') setSizeMode(stored)
    } catch {
      // Storage can be unavailable; keep Lots for this session.
    }
  }, [])

  function changeSizeMode(mode: SizeMode) {
    setSizeMode(mode)
    try {
      window.localStorage.setItem(SIZE_MODE_KEY, mode)
    } catch {
      // Storage can be unavailable; the choice still applies for this session.
    }
  }

  const meta = getSymbol(selectedSymbol)
  const sl = stopLoss === '' ? null : Number(stopLoss)
  const tp = takeProfit === '' ? null : Number(takeProfit)
  const limit = limitPrice === '' ? null : Number(limitPrice)
  const stop = stopPrice === '' ? null : Number(stopPrice)
  const pendingPrice = pendingType === 'STOP' ? stop : limit
  const validPending =
    pendingType === 'LIMIT'
      ? limit != null && limit > 0
      : pendingType === 'STOP'
        ? stop != null && stop > 0
        : limit != null && limit > 0 && stop != null && stop > 0
  const entry = side === 'BUY' ? ask : bid
  const parsedUsd = usdAmount === '' ? null : Number(usdAmount)
  const rawLots =
    sizeMode === 'usd'
      ? lotsForMarginUsd(selectedSymbol, parsedUsd ?? 0, entry, leverage)
      : Number(lots)
  // USD mode allocates margin and must respect the broker's 0.01 lot step.
  const sizeLots = sizeMode === 'usd' ? Math.floor(rawLots * 100) / 100 : rawLots
  const validLots = Number.isFinite(sizeLots) && sizeLots >= MIN_ORDER_LOTS
  const lotsTooLarge = validLots && sizeLots > MAX_ORDER_LOTS
  const pipValue = validLots ? pipValueUsd(selectedSymbol, sizeLots, entry) : 0
  const margin = validLots ? requiredMarginUsd(selectedSymbol, sizeLots, entry, leverage) : 0
  const minMargin = requiredMarginUsd(selectedSymbol, MIN_ORDER_LOTS, entry, leverage)
  const usdInvalid = sizeMode === 'usd' && parsedUsd != null && (!Number.isFinite(parsedUsd) || parsedUsd <= 0)
  const usdTooSmall =
    sizeMode === 'usd' &&
    parsedUsd != null &&
    Number.isFinite(parsedUsd) &&
    parsedUsd > 0 &&
    parsedUsd < minMargin
  const marginExceeds = validLots && margin > freeMargin + 0.005
  const tradable = accountStatus === 'ACTIVE' && getSymbol(selectedSymbol).available

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
    !lotsTooLarge &&
    !usdInvalid &&
    !usdTooSmall &&
    !marginExceeds &&
    !busy &&
    (orderType === 'market' || validPending) &&
    (sl == null || Number.isFinite(sl)) &&
    (tp == null || Number.isFinite(tp))

  async function execute() {
    if (!canSubmit) return
    setBusy(true)
    setNotice(null)
    try {
      if (orderType === 'limit' && validPending && pendingPrice) {
        const result = await placePending({
          symbol: selectedSymbol,
          side,
          sizeLots,
          type: pendingType,
          limitPrice: pendingType === 'STOP' ? (stop as number) : (limit as number),
          stopPrice: pendingType === 'LIMIT' ? null : stop,
          stopLoss: sl,
          takeProfit: tp,
        })
        const label = pendingType === 'STOP' ? 'Stop' : pendingType === 'STOP_LIMIT' ? 'Stop-limit' : 'Limit'
        const detail =
          pendingType === 'STOP_LIMIT'
            ? `trigger ${formatPrice(selectedSymbol, stop as number)} / limit ${formatPrice(selectedSymbol, limit as number)}`
            : `at ${formatPrice(selectedSymbol, pendingPrice)}`
        setNotice(
          result.ok
            ? { tone: 'ok', text: `${label} ${side} ${sizeLots} ${meta.displayName} queued ${detail}` }
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
            <TabsTrigger value="limit">Pending</TabsTrigger>
          </TabsList>
          <TabsContent value="market" className="mt-3 text-xs text-muted-foreground">
            Live reference price with an indicative spread; not an executable broker bid/ask.
          </TabsContent>
          <TabsContent value="limit" className="mt-3 space-y-3">
            <div className="grid grid-cols-3 gap-1">
              {(['LIMIT', 'STOP', 'STOP_LIMIT'] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setPendingType(type)}
                  className={cn(
                    'rounded-md border px-1.5 py-1.5 font-mono text-[10px] uppercase tracking-wide transition-colors',
                    pendingType === type
                      ? 'border-primary/50 bg-primary/15 text-primary'
                      : 'border-border bg-secondary/40 text-muted-foreground hover:text-foreground',
                  )}
                >
                  {type === 'STOP_LIMIT' ? 'Stop-limit' : type === 'STOP' ? 'Stop' : 'Limit'}
                </button>
              ))}
            </div>
            {pendingType !== 'LIMIT' ? (
              <Field label="Stop price">
                <input
                  inputMode="decimal"
                  value={stopPrice}
                  onChange={(event) => setStopPrice(event.target.value)}
                  placeholder={formatPrice(selectedSymbol, entry)}
                  className={inputClass}
                />
              </Field>
            ) : null}
            {pendingType !== 'STOP' ? (
              <Field label="Limit price">
                <input
                  inputMode="decimal"
                  value={limitPrice}
                  onChange={(event) => setLimitPrice(event.target.value)}
                  placeholder={formatPrice(selectedSymbol, entry)}
                  className={inputClass}
                />
              </Field>
            ) : null}
            <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
              {pendingType === 'LIMIT'
                ? 'Fills when the market reaches your limit price.'
                : pendingType === 'STOP'
                  ? 'Triggers a market order when the stop price is reached.'
                  : 'Triggers at the stop price, then waits for the limit price.'}
            </p>
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

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Order size</span>
            <div className="flex rounded-md border border-border bg-secondary/60 p-0.5" role="tablist" aria-label="Order size mode">
              {(['lots', 'usd'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={sizeMode === mode}
                  onClick={() => changeSizeMode(mode)}
                  className={cn(
                    'rounded px-2 py-1 font-mono text-[10px] font-medium uppercase tracking-wide transition-colors',
                    sizeMode === mode ? 'bg-background text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {mode === 'lots' ? 'Lots' : 'USD'}
                </button>
              ))}
            </div>
          </div>

          <Field label={sizeMode === 'lots' ? 'Lot size' : 'Margin amount (USD)'}>
            <input
              inputMode="decimal"
              value={sizeMode === 'lots' ? lots : usdAmount}
              onChange={(event) => (sizeMode === 'lots' ? setLots(event.target.value) : setUsdAmount(event.target.value))}
              placeholder={sizeMode === 'lots' ? '0.10' : '500'}
              className={inputClass}
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(sizeMode === 'lots' ? LOT_PRESETS : USD_PRESETS).map((preset) => {
                const active =
                  sizeMode === 'lots' ? Number(lots) === preset : Number(usdAmount) === preset
                return (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => (sizeMode === 'lots' ? setLots(preset.toFixed(2)) : setUsdAmount(String(preset)))}
                    className={cn(
                      'rounded-full border px-2 py-0.5 font-mono text-[11px]',
                      active
                        ? 'border-primary/40 bg-primary/15 text-primary'
                        : 'border-border text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {sizeMode === 'lots' ? preset.toFixed(2) : formatUsd(preset)}
                  </button>
                )
              })}
            </div>
            <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
              {sizeMode === 'lots' ? (
                <>~{formatUsd(pipValue)} / pip · margin {formatUsd(margin)}</>
              ) : (
                <>≈ {Number.isFinite(sizeLots) ? sizeLots.toFixed(2) : '0.00'} lots · margin {formatUsd(margin)} of {formatUsd(parsedUsd ?? 0)}</>
              )}
            </p>
            {sizeMode === 'usd' ? (
              <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                USD is a margin budget; lots are rounded down to 0.01. Free margin {formatUsd(freeMargin)}.
              </p>
            ) : null}
            {usdTooSmall ? (
              <p role="alert" className="mt-1 font-mono text-[11px] text-danger">
                Недостатньо коштів навіть для мінімального ордера (0.01 лота)
              </p>
            ) : null}
            {usdInvalid ? (
              <p role="alert" className="mt-1 font-mono text-[11px] text-danger">
                Enter a positive USD amount.
              </p>
            ) : null}
            {lotsTooLarge ? (
              <p role="alert" className="mt-1 font-mono text-[11px] text-danger">
                Maximum order size is {MAX_ORDER_LOTS.toFixed(2)} lots.
              </p>
            ) : null}
            {marginExceeds ? (
              <p role="alert" className="mt-1 font-mono text-[11px] text-danger">
                Insufficient free margin: requires {formatUsd(margin)}, available {formatUsd(freeMargin)}.
              </p>
            ) : null}
          </Field>
        </div>

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
          {busy
            ? 'Working…'
            : orderType === 'limit'
              ? `Place ${pendingType === 'STOP_LIMIT' ? 'stop-limit' : pendingType.toLowerCase()} order`
              : 'Execute trade'}
        </Button>
        {!tradable && accountStatus ? (
          <p className="font-mono text-[11px] text-muted-foreground">
            {accountStatus !== 'ACTIVE' ? `Account ${accountStatus.toLowerCase()} — orders disabled` : 'Symbol not tradable on this account'}
          </p>
        ) : null}
        {tradable && connectionStatus !== 'CONNECTED' ? (
          <p className="font-mono text-[11px] text-warning">Waiting for a fresh market quote — orders disabled</p>
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
