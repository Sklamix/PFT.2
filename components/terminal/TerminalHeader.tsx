'use client'

import { useState } from 'react'
import { Check, ChevronDown, Clock, Plus, Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SYMBOL_GROUPS, formatPrice, formatSpreadValue, getSymbol, type TerminalSymbolId } from '@/lib/constants/symbols'
import { isIndexMarketOpen } from '@/lib/market/index-sessions'
import { formatPct, formatUsd } from '@/lib/dashboard-data'
import { useNow } from '@/hooks/use-now'
import { useFavoritesStore } from '@/lib/stores/useFavoritesStore'
import { useTerminalBook } from '@/lib/stores/useTerminalBook'
import { NotificationCenter } from './NotificationCenter'
import { TIMEZONE_OPTIONS, timeZoneOffsetLabel, useTimezoneStore } from '@/lib/stores/useTimezoneStore'
import { useTradingStore } from '@/lib/stores/useTradingStore'
import { cn } from '@/lib/utils'

export function TerminalHeader() {
  const selectedSymbol = useTradingStore((state) => state.selectedSymbol)
  const setSelectedSymbol = useTradingStore((state) => state.setSelectedSymbol)
  const bid = useTradingStore((state) => state.bid)
  const ask = useTradingStore((state) => state.ask)
  const spread = useTradingStore((state) => state.spread)
  const change = useTradingStore((state) => state.priceChangePercent24h)
  const connectionStatus = useTradingStore((state) => state.connectionStatus)
  const feedMode = useTradingStore((state) => state.feedMode)
  const snapshot = useTerminalBook((state) => state.snapshot)
  const account = useTerminalBook((state) => state.account)
  const now = useNow()
  const live = connectionStatus === 'CONNECTED' && feedMode === 'LIVE'
  const marketClosed =
    getSymbol(selectedSymbol).category === 'index' &&
    !isIndexMarketOpen(selectedSymbol, new Date(now ?? Date.now()))
  const feedLabel = live ? 'Live · indicative spread' : marketClosed ? 'Market closed' : connectionStatus.toLowerCase()
  const up = change >= 0
  const ddRatio = snapshot.dailyUsedRatio

  return (
    <header className="flex flex-col gap-3 border-b border-border bg-card/80 px-3 py-2.5 backdrop-blur-md xl:px-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <SymbolPicker selectedSymbol={selectedSymbol} onSelect={setSelectedSymbol} />
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 font-mono">
          <QuoteStack label="Bid" value={formatPrice(selectedSymbol, bid)} tone="danger" />
          <QuoteStack label="Ask" value={formatPrice(selectedSymbol, ask)} tone="primary" />
          <div className="hidden sm:block">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Spread</p>
            <p className="text-sm tabular-nums text-foreground">{formatSpreadValue(selectedSymbol, spread)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">24h</p>
            <p className={cn('text-sm tabular-nums', up ? 'text-primary' : 'text-danger')}>{formatPct(change, true)}</p>
          </div>
          <StatusChip status={account ? account.status : '—'} />
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider',
              live
                ? 'border-primary/30 bg-primary/10 text-primary'
                : 'border-danger/30 bg-danger/10 text-danger',
            )}
          >
            <span
              className={cn('size-1.5 rounded-full', live ? 'bg-primary' : 'bg-danger')}
              aria-hidden="true"
            />
            {feedLabel}
          </span>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-3">
          <NotificationCenter />
          <TimezoneClock />
        </div>
      </div>

      {/* A description list: each Stat renders dt/dd, which must live inside a dl. */}
      <dl className="flex flex-wrap items-stretch gap-x-6 gap-y-3 border-t border-border pt-3">
        {/* Zone A — how much money */}
        <div className="min-w-0 flex-1">
          <Stat
            label="EQUITY"
            value={formatUsd(snapshot.equity)}
            tone={snapshot.floatingPnl >= 0 ? 'primary' : 'danger'}
            size="hero"
          />
          <div className="mt-1 flex flex-col gap-0.5">
            <Stat label="BALANCE" value={formatUsd(snapshot.balance)} tone="muted" size="sm" />
            <Stat label="FREE MARGIN" value={formatUsd(snapshot.freeMargin)} tone="muted" size="sm" />
          </div>
        </div>

        {/* Zone B — how much is used */}
        <div className="border-l border-border pl-6 shrink-0">
          <Stat label="MARGIN" value={formatUsd(snapshot.marginUsed)} tone="normal" size="sm" />
        </div>

        {/* Zone C — how much is left before breach */}
        <div className="border-l border-border pl-6 flex-1 min-w-0">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-muted-foreground">
            <span>DAILY DD BUFFER</span>
            <span className="font-mono tabular-nums text-foreground">{formatUsd(snapshot.dailyBufferUsd)}</span>
            <span
              className={cn(
                'font-mono tabular-nums text-[10px]',
                ddRatio >= 0.8 ? 'text-danger' : ddRatio >= 0.5 ? 'text-warning' : 'text-muted-foreground',
              )}
            >
              · {Math.round(ddRatio * 100)}% used
            </span>
          </div>
          <div
            className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary"
            role="meter"
            aria-label="Daily drawdown buffer remaining"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((1 - ddRatio) * 100)}
          >
            <div
              className={cn(
                'h-full rounded-full transition-[width]',
                ddRatio >= 0.8 ? 'bg-danger' : ddRatio >= 0.5 ? 'bg-warning' : 'bg-primary',
              )}
              style={{ width: `${Math.max(4, (1 - ddRatio) * 100)}%` }}
            />
          </div>
        </div>
      </dl>
    </header>
  )
}

function SymbolPicker({
  selectedSymbol,
  onSelect,
}: {
  selectedSymbol: TerminalSymbolId | string
  onSelect: (symbol: string) => void
}) {
  const [query, setQuery] = useState('')
  const favorites = useFavoritesStore((state) => state.favorites)
  const toggleFavorite = useFavoritesStore((state) => state.toggleFavorite)
  const normalized = query.trim().toLowerCase()
  const matches = (id: TerminalSymbolId) => {
    if (!normalized) return true
    const item = getSymbol(id)
    return (
      id.toLowerCase().includes(normalized) ||
      item.displayName.toLowerCase().includes(normalized) ||
      item.name.toLowerCase().includes(normalized)
    )
  }

  const groups = SYMBOL_GROUPS.map((group) => ({ ...group, symbols: group.symbols.filter(matches) })).filter(
    (group) => group.symbols.length > 0,
  )

  function select(id: TerminalSymbolId) {
    if (!getSymbol(id).available) return
    // A symbol chosen from search becomes part of the visible list automatically.
    if (!favorites.includes(id)) toggleFavorite(id)
    onSelect(id)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" className="h-9 min-w-40 justify-between gap-2 font-mono" />}>
        <span className="flex flex-col items-start leading-none">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Symbol</span>
          <span className="mt-0.5 text-sm text-foreground">{getSymbol(selectedSymbol).displayName}</span>
        </span>
        <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80 p-0">
        <div className="border-b border-border p-2">
          <label className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5">
            <Plus className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') event.stopPropagation()
              }}
              placeholder="Add symbols"
              aria-label="Add symbols"
              className="h-8 w-full bg-transparent font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
            />
          </label>
        </div>

        <div className="max-h-80 overflow-y-auto p-1">
          {!normalized && favorites.length > 0 && (
            <DropdownMenuGroup>
              <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-widest text-highlight">
                Favorites
              </DropdownMenuLabel>
              {favorites.map((id) => (
                <SymbolRow
                  key={id}
                  id={id}
                  selected={selectedSymbol === id}
                  favorite
                  onSelect={select}
                  onToggleFavorite={toggleFavorite}
                />
              ))}
            </DropdownMenuGroup>
          )}

          {!normalized && favorites.length === 0 && (
            <div className="px-3 py-8 text-center">
              <Plus className="mx-auto size-5 text-muted-foreground" aria-hidden="true" />
              <p className="mt-2 text-sm font-medium text-foreground">Add symbols</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Search above and tap the star to build your terminal list.
              </p>
            </div>
          )}

          {normalized &&
            groups.map((group, index) => (
              <DropdownMenuGroup key={group.id}>
                <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  {group.label}
                </DropdownMenuLabel>
                {group.symbols.map((id) => (
                  <SymbolRow
                    key={id}
                    id={id}
                    selected={selectedSymbol === id}
                    favorite={favorites.includes(id)}
                    onSelect={select}
                    onToggleFavorite={toggleFavorite}
                  />
                ))}
                {index < groups.length - 1 && <DropdownMenuSeparator />}
              </DropdownMenuGroup>
            ))}

          {normalized && groups.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">No assets match “{query.trim()}”.</p>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SymbolRow({
  id,
  selected,
  favorite,
  onSelect,
  onToggleFavorite,
}: {
  id: TerminalSymbolId
  selected: boolean
  favorite: boolean
  onSelect: (symbol: TerminalSymbolId) => void
  onToggleFavorite: (symbol: TerminalSymbolId) => void
}) {
  const item = getSymbol(id)
  return (
    <DropdownMenuItem
      aria-disabled={!item.available}
      onClick={() => {
        if (item.available) onSelect(id)
      }}
      className={cn(
        'flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-2 font-mono',
        selected && 'bg-primary/10',
        !item.available && 'cursor-not-allowed opacity-60',
      )}
    >
      <span className="flex min-w-0 flex-col">
        <span className="flex items-center gap-2 text-sm text-foreground">
          {item.displayName}
          {!item.available && (
            <span className="rounded-full border border-border bg-muted/70 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-wide text-muted-foreground">
              Soon
            </span>
          )}
        </span>
        <span className="truncate text-[10px] text-muted-foreground">{item.name}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {selected && <Check className="size-3.5 text-primary" aria-hidden="true" />}
        <button
          type="button"
          aria-label={favorite ? `Remove ${item.displayName} from favorites` : `Add ${item.displayName} to favorites`}
          aria-pressed={favorite}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onToggleFavorite(id)
          }}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-highlight focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Star className={cn('size-3.5', favorite && 'fill-highlight text-highlight')} aria-hidden="true" />
        </button>
      </span>
    </DropdownMenuItem>
  )
}

function TimezoneClock() {
  const now = useNow()
  const timeZone = useTimezoneStore((state) => state.timeZone)
  const setTimeZone = useTimezoneStore((state) => state.setTimeZone)
  const label = TIMEZONE_OPTIONS.find((option) => option.value === timeZone)?.label ?? timeZone
  const time = now === null
    ? '--:--:--'
    : new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(now))
  const date = now === null
    ? ''
    : new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: 'short' }).format(new Date(now))

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" className="h-9 shrink-0 justify-between gap-2 border-border bg-card px-2.5" />}
        aria-label={`Terminal time ${time} ${label}. Change timezone`}>

        <Clock className="size-4 text-primary" aria-hidden="true" />
        <span className="flex flex-col items-start leading-none">
          <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
            {label} · {timeZoneOffsetLabel(timeZone)}
          </span>
          <span className="mt-0.5 font-mono text-xs tabular-nums text-foreground">
            {time} <span className="text-muted-foreground">{date}</span>
          </span>
        </span>
        <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Chart timezone</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={timeZone} onValueChange={setTimeZone}>
          {TIMEZONE_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} className="font-mono text-xs">
              <span className="flex w-full items-center justify-between gap-4">
                <span>{option.label}</span>
                <span className="text-[10px] text-muted-foreground">{timeZoneOffsetLabel(option.value)}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function QuoteStack({ label, value, tone }: { label: string; value: string; tone: 'primary' | 'danger' }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className={cn('text-sm font-semibold tabular-nums', tone === 'primary' ? 'text-primary' : 'text-danger')}>{value}</p>
    </div>
  )
}

/** Status chip — moved to row 1 per the terminal header spec. */
function StatusChip({ status }: { status: string }) {
  const active = status === 'ACTIVE'
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider',
        active ? 'border-primary/30 bg-primary/10 text-primary' : 'border-danger/30 bg-danger/10 text-danger',
      )}
      aria-label={`Account status: ${status}`}
    >
      <span className="relative flex size-1.5" aria-hidden="true">
        {active ? (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60 motion-reduce:animate-none" />
        ) : null}
        <span className={cn('relative inline-flex size-1.5 rounded-full', active ? 'bg-primary' : 'bg-danger')} />
      </span>
      {status}
    </span>
  )
}

/**
 * A single header metric with an explicit accent level.
 * `size="hero"` is used for Equity; `size="sm"` for the rest.
 */
function Stat({ label, value, tone = 'normal', size = 'sm' }: {
  label: string
  value: string
  tone?: 'normal' | 'primary' | 'danger' | 'muted' | 'warning'
  size?: 'sm' | 'hero'
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'font-mono tabular-nums',
          size === 'hero' ? 'text-2xl font-semibold' : 'text-[13px]',
          tone === 'primary' ? 'text-primary' : tone === 'danger' ? 'text-danger' : tone === 'muted' ? 'text-muted-foreground' : tone === 'warning' ? 'text-warning' : 'text-foreground',
        )}
      >
        {value}
      </dd>
    </div>
  )
}
