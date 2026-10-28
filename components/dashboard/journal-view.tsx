'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Camera, ChevronDown, ExternalLink, StickyNote, Tag, X } from 'lucide-react'
import { useJournal, type JournalTrade } from '@/lib/stores/useJournal'
import { useSelectedAccount } from '@/lib/stores/useSelectedAccount'
import { SpaceBackground } from './space-background'
import { cn } from '@/lib/utils'

const LABEL = '#94A3B8'
const GREEN = '#22C55E'
const RED = '#EF4444'

const TAG_SUGGESTIONS = ['SMC FVG', 'Breakout', 'Trend continuation', 'Reversal', 'News trade', 'Revenge trade', 'Overleveraged', 'A+ setup']

const usd = (n: number) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const signedUsd = (n: number) =>
  `${n >= 0 ? '+' : '-'}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const dateFmt = (t: number) =>
  new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function Card({ title, children, className = '' }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-xl border border-slate-800/80 bg-[#0B0F19]/80 p-5 backdrop-blur-md', className)}>
      {title ? (
        <h2 className="mb-4 text-[11px] font-medium uppercase tracking-[0.18em] text-[#94A3B8]">{title}</h2>
      ) : null}
      {children}
    </section>
  )
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-slate-800/80 bg-[#0B0F19]/80 p-5 backdrop-blur-md">
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#94A3B8]">{label}</p>
      <p className="mt-2 font-mono text-2xl font-semibold tabular-nums tracking-tight" style={{ color: tone ?? '#F1F5F9' }}>
        {value}
      </p>
    </div>
  )
}

function SideBadge({ side }: { side: string }) {
  const buy = side === 'BUY'
  return (
    <span
      className="rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider"
      style={{
        color: buy ? GREEN : RED,
        backgroundColor: buy ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
      }}
    >
      {side}
    </span>
  )
}

function JournalDrawer({ trade, onClose, onSaved }: { trade: JournalTrade; onClose: () => void; onSaved: () => void }) {
  const [note, setNote] = useState(trade.note)
  const [tags, setTags] = useState<string[]>(trade.tags)
  const [tagInput, setTagInput] = useState('')
  const [screenshot, setScreenshot] = useState<string | null>(trade.screenshot)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const addTag = (tag: string) => {
    const clean = tag.trim().slice(0, 30)
    if (!clean || tags.includes(clean) || tags.length >= 8) return
    setTags([...tags, clean])
    setTagInput('')
  }

  const pickScreenshot = (file: File | undefined) => {
    if (!file) return
    if (file.size > 600 * 1024) {
      setError('Screenshot is too large (max 600 KB).')
      return
    }
    const reader = new FileReader()
    reader.onload = () => setScreenshot(typeof reader.result === 'string' ? reader.result : null)
    reader.readAsDataURL(file)
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/dashboard/journal/${encodeURIComponent(trade.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note, tags, screenshot }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? 'Unable to save.')
      } else {
        onSaved()
        onClose()
      }
    } catch {
      setError('Network error. Try again.')
    }
    setBusy(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/70" onClick={onClose}>
      <div
        className="h-full w-full max-w-md overflow-y-auto border-l border-slate-800/80 bg-[#0B0F19] p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 font-mono text-sm font-semibold text-slate-100">
            {trade.symbol} <SideBadge side={trade.side} />
            <span className="text-[10px] font-normal text-slate-600">#{trade.id.slice(-8).toUpperCase()}</span>
          </h3>
          <button type="button" onClick={onClose} className="text-xs text-[#94A3B8] hover:text-slate-200" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-3 text-xs">
          {(
            [
              ['Open price', trade.entryPrice.toFixed(5)],
              ['Close price', trade.exitPrice.toFixed(5)],
              ['Volume', `${trade.sizeLots.toFixed(2)} lots`],
              ['Duration', duration(trade.durationMs)],
              ['Opened', dateFmt(trade.openedAt)],
              ['Closed', dateFmt(trade.closedAt)],
              ['Net PnL', signedUsd(trade.pnl)],
              ['Return', `${trade.pnlPct >= 0 ? '+' : ''}${trade.pnlPct.toFixed(2)}%`],
            ] as [string, string][]
          ).map(([term, value]) => (
            <div key={term} className="rounded-md border border-slate-800/60 px-3 py-2">
              <dt className="text-[10px] uppercase tracking-[0.16em] text-[#94A3B8]">{term}</dt>
              <dd
                className="mt-0.5 font-mono tabular-nums text-slate-100"
                style={term === 'Net PnL' || term === 'Return' ? { color: trade.pnl >= 0 ? GREEN : RED } : undefined}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>

        {/* Reflective note */}
        <div className="mt-6">
          <label className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#94A3B8]" htmlFor="journal-note">
            Reflective note
          </label>
          <textarea
            id="journal-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={4000}
            placeholder="What was the setup? What did you execute well or poorly?"
            className="mt-2 min-h-28 w-full rounded-md border border-slate-800 bg-[#080C14] p-3 text-sm text-slate-200 outline-none focus:border-slate-600"
          />
        </div>

        {/* Tags */}
        <div className="mt-5">
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-[#94A3B8]">
            <Tag className="size-3" /> Strategy / psychology tags
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {TAG_SUGGESTIONS.filter((tag) => !tags.includes(tag)).map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => addTag(tag)}
                className="rounded-full border border-slate-800 px-2.5 py-1 text-[11px] text-[#94A3B8] hover:border-slate-600 hover:text-slate-200"
              >
                + {tag}
              </button>
            ))}
          </div>
          {tags.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded-full bg-slate-800/60 px-2.5 py-1 text-[11px] text-slate-200"
                >
                  {tag}
                  <button type="button" onClick={() => setTags(tags.filter((item) => item !== tag))} aria-label={`Remove ${tag}`}>
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <input
            value={tagInput}
            onChange={(event) => setTagInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addTag(tagInput)
              }
            }}
            placeholder="Custom tag + Enter"
            className="mt-2 h-8 w-full rounded-md border border-slate-800 bg-[#080C14] px-3 text-xs text-slate-200 outline-none focus:border-slate-600"
          />
        </div>

        {/* Screenshot */}
        <div className="mt-5">
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-[#94A3B8]">
            <Camera className="size-3" /> Chart screenshot
          </p>
          {screenshot ? (
            <div className="mt-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={screenshot} alt="Trade screenshot" className="max-h-48 w-full rounded-md border border-slate-800 object-contain" />
              <button type="button" onClick={() => setScreenshot(null)} className="mt-1 text-[11px] text-[#94A3B8] hover:text-slate-200">
                Remove screenshot
              </button>
            </div>
          ) : (
            <input
              type="file"
              accept="image/*"
              onChange={(event) => pickScreenshot(event.target.files?.[0])}
              className="mt-2 block w-full text-xs text-[#94A3B8] file:mr-3 file:rounded-md file:border file:border-slate-800 file:bg-transparent file:px-3 file:py-1.5 file:text-xs file:text-slate-200"
            />
          )}
        </div>

        {error ? (
          <p className="mt-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs" style={{ color: RED }}>
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex gap-2 pb-6">
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="h-9 flex-1 rounded-md border border-slate-600 text-xs text-slate-100 hover:bg-slate-800/60 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save journal entry'}
          </button>
          <button type="button" onClick={onClose} className="h-9 rounded-md px-4 text-xs text-[#94A3B8] hover:text-slate-200">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function TradeCard({ trade, onOpen }: { trade: JournalTrade; onOpen: () => void }) {
  const pnlColor = trade.pnl >= 0 ? GREEN : RED
  return (
    <button
      type="button"
      onClick={onOpen}
      className="rounded-xl border border-slate-800/80 bg-[#0B0F19]/80 p-5 text-left backdrop-blur-md transition-colors hover:border-slate-600"
      aria-label={`Open journal entry for ${trade.symbol} ${trade.side}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-slate-100">{trade.symbol}</span>
          <SideBadge side={trade.side} />
        </div>
        <span className="font-mono text-[10px] text-slate-600">#{trade.id.slice(-8).toUpperCase()}</span>
      </div>

      {/* Body */}
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
        <p className="text-[#94A3B8]">
          Open <span className="font-mono tabular-nums text-slate-200">{trade.entryPrice.toFixed(5)}</span>
        </p>
        <p className="text-[#94A3B8]">
          Close <span className="font-mono tabular-nums text-slate-200">{trade.exitPrice.toFixed(5)}</span>
        </p>
        <p className="text-[#94A3B8]">
          Volume <span className="font-mono tabular-nums text-slate-200">{trade.sizeLots.toFixed(2)} lots</span>
        </p>
        <p className="text-[#94A3B8]">
          Duration <span className="font-mono tabular-nums text-slate-200">{duration(trade.durationMs)}</span>
        </p>
        <p className="col-span-2 text-[#94A3B8]">
          <span className="font-mono tabular-nums text-slate-600">
            {dateFmt(trade.openedAt)} → {dateFmt(trade.closedAt)}
          </span>
        </p>
      </div>

      {/* PnL */}
      <p className="mt-3 font-mono text-xl font-semibold tabular-nums" style={{ color: pnlColor }}>
        {signedUsd(trade.pnl)}{' '}
        <span className="text-xs opacity-80">
          ({trade.pnlPct >= 0 ? '+' : ''}
          {trade.pnlPct.toFixed(2)}%)
        </span>
      </p>

      {/* Footer */}
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-800/60 pt-3">
        <div className="flex min-w-0 flex-wrap gap-1">
          {trade.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="rounded-full bg-slate-800/60 px-2 py-0.5 text-[10px] text-[#94A3B8]">
              {tag}
            </span>
          ))}
          {trade.note && !trade.tags.length ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-[#94A3B8]">
              <StickyNote className="size-3" /> Note saved
            </span>
          ) : null}
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-[#94A3B8]">
          <ExternalLink className="size-3" /> Details
        </span>
      </div>
    </button>
  )
}

export function JournalView() {
  const data = useJournal((state) => state.data)
  const loadState = useJournal((state) => state.loadState)
  const error = useJournal((state) => state.error)
  const filters = useJournal((state) => state.filters)
  const openTradeId = useJournal((state) => state.openTradeId)
  const load = useJournal((state) => state.load)
  const setFilters = useJournal((state) => state.setFilters)
  const setOpenTrade = useJournal((state) => state.setOpenTrade)

  const globalAccountId = useSelectedAccount((state) => state.accountId)
  const globalSelect = useSelectedAccount((state) => state.select)

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 15_000)
    return () => window.clearInterval(timer)
  }, [load])

  const trades = data ?? []
  const accountOptions = useMemo(() => {
    const map = new Map<string, string>()
    for (const trade of trades) map.set(trade.accountId, trade.accountDisplayId)
    return [...map.entries()]
  }, [trades])

  const filtered = useMemo(() => {
    const minTime = filters.range === 'all' ? 0 : Date.now() - (filters.range === '7d' ? 7 : filters.range === '30d' ? 30 : 90) * 86_400_000
    return trades.filter(
      (trade) =>
        (globalAccountId === '' || globalAccountId === 'all' || trade.accountId === globalAccountId) &&
        trade.closedAt >= minTime &&
        (filters.symbol === 'all' || trade.symbol === filters.symbol) &&
        (filters.side === 'all' || trade.side === filters.side),
    )
  }, [trades, filters, globalAccountId])

  const kpis = useMemo(() => {
    const total = filtered.length
    const wins = filtered.filter((trade) => trade.pnl > 0)
    const losses = filtered.filter((trade) => trade.pnl < 0)
    const grossWin = wins.reduce((sum, trade) => sum + trade.pnl, 0)
    const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0))
    const avgWin = wins.length ? grossWin / wins.length : 0
    const avgLoss = losses.length ? grossLoss / losses.length : 0
    return {
      winRate: total ? (wins.length / total) * 100 : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
      avgRR: avgLoss > 0 ? avgWin / avgLoss : 0,
      total,
      netPnl: filtered.reduce((sum, trade) => sum + trade.pnl, 0),
    }
  }, [filtered])

  const symbols = useMemo(() => [...new Set(trades.map((trade) => trade.symbol))].sort(), [trades])
  const openTrade = trades.find((trade) => trade.id === openTradeId) ?? null

  return (
    <div className="min-h-dvh">
      <SpaceBackground />
      <div className="relative z-10 mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Header controls */}
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-slate-100">Trading Journal</h1>
              <p className="mt-0.5 text-sm text-[#94A3B8]">Closed trades synced from the live terminal.</p>
            </div>
            {accountOptions.length > 0 ? (
              <select
                value={globalAccountId && globalAccountId !== 'all' && accountOptions.some(([id]) => id === globalAccountId) ? globalAccountId : 'all'}
                onChange={(event) => globalSelect(event.target.value === 'all' ? '' : event.target.value)}
                className="h-9 rounded-md border border-slate-800 bg-[#0B0F19]/80 px-3 font-mono text-sm text-slate-200 outline-none focus:border-slate-600"
                aria-label="Select account"
              >
                <option value="all">All accounts</option>
                {accountOptions.map(([id, displayId]) => (
                  <option key={id} value={id}>
                    {displayId}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={filters.range}
              onChange={(event) => setFilters({ range: event.target.value as typeof filters.range })}
              className="h-8 rounded-md border border-slate-800 bg-[#0B0F19]/80 px-2 text-xs text-slate-200 outline-none focus:border-slate-600"
              aria-label="Date range"
            >
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
              <option value="all">All time</option>
            </select>
            <select
              value={filters.symbol}
              onChange={(event) => setFilters({ symbol: event.target.value })}
              className="h-8 rounded-md border border-slate-800 bg-[#0B0F19]/80 px-2 font-mono text-xs text-slate-200 outline-none focus:border-slate-600"
              aria-label="Symbol filter"
            >
              <option value="all">All symbols</option>
              {symbols.map((symbol) => (
                <option key={symbol} value={symbol}>
                  {symbol}
                </option>
              ))}
            </select>
            <div className="flex gap-1">
              {(['all', 'BUY', 'SELL'] as const).map((side) => (
                <button
                  key={side}
                  type="button"
                  onClick={() => setFilters({ side })}
                  aria-pressed={filters.side === side}
                  className={cn(
                    'h-8 rounded-md px-3 text-xs transition-colors',
                    filters.side === side ? 'bg-slate-800/60 text-slate-100' : 'text-[#94A3B8] hover:text-slate-200',
                  )}
                >
                  {side === 'all' ? 'All' : side}
                </button>
              ))}
            </div>
          </div>
        </header>

        {/* KPI row */}
        <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
          <Kpi label="Win Rate" value={`${kpis.winRate.toFixed(1)}%`} tone={kpis.winRate >= 50 ? GREEN : '#F1F5F9'} />
          <Kpi
            label="Profit Factor"
            value={kpis.profitFactor === Infinity ? '∞' : kpis.profitFactor.toFixed(2)}
            tone={kpis.profitFactor >= 1 ? GREEN : RED}
          />
          <Kpi label="Avg Risk:Reward" value={kpis.avgRR > 0 ? `1 : ${kpis.avgRR.toFixed(2)}` : '—'} />
          <Kpi label="Total Trades" value={String(kpis.total)} />
          <Kpi label="Net PnL" value={signedUsd(kpis.netPnl)} tone={kpis.netPnl >= 0 ? GREEN : RED} />
        </div>

        {/* Cards grid */}
        <div className="mt-6">
          {loadState === 'error' ? (
            <p className="text-sm text-[#94A3B8]">{error ?? 'Unable to load journal.'}</p>
          ) : loadState !== 'ready' ? (
            <p className="text-sm text-[#94A3B8]">Loading journal…</p>
          ) : filtered.length === 0 ? (
            <Card>
              <p className="py-8 text-center text-sm text-[#94A3B8]">
                No closed trades match these filters — close a position in the Live Terminal to see it here.
              </p>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((trade) => (
                <TradeCard key={trade.id} trade={trade} onOpen={() => setOpenTrade(trade.id)} />
              ))}
            </div>
          )}
        </div>
      </div>

      {openTrade ? (
        <JournalDrawer trade={openTrade} onClose={() => setOpenTrade(null)} onSaved={() => void load()} />
      ) : null}
    </div>
  )
}
