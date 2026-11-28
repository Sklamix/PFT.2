'use client'

import { useState, type ReactNode } from 'react'
import { BarChart3, Check, ChevronDown, Clock, Plus, Scale, ShieldAlert, Star } from 'lucide-react'
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
    <div className="flex min-w-0 flex-col">
      {/* Quote row — 80px, inside the shared terminal card. */}
      <div className="flex min-h-[80px] flex-wrap items-center gap-x-5 gap-y-3 border-b border-white/[0.06] px-6 py-3">
        <SymbolPicker selectedSymbol={selectedSymbol} onSelect={setSelectedSymbol} />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-5 gap-y-2">
          <div className="flex shrink-0 items-stretch divide-x divide-white/[0.06]">
            <QuoteStack label="Bid" value={formatPrice(selectedSymbol, bid)} tone="danger" />
            <QuoteStack label="Ask" value={formatPrice(selectedSymbol, ask)} tone="primary" />
            <div className="hidden px-4 sm:block">
              <p className="text-[10px] uppercase tracking-[0.08em] text-[#8FA3C4]">Spread</p>
              <p className="mt-0.5 font-mono text-[15px] font-semibold tabular-nums text-[#F4F7FF]">{formatSpreadValue(selectedSymbol, spread)}</p>
            </div>
            <div className="pl-4 pr-0">
              <p className="text-[10px] uppercase tracking-[0.08em] text-[#8FA3C4]">24h</p>
              <QuoteDelta value={formatPct(change, true)} up={up} />
            </div>
          </div>
          <StatusChip status={account ? account.status : '—'} />
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.06em]',
              live
                ? 'border-[#307DFD]/35 bg-[#307DFD]/10 text-[#307DFD]'
                : 'border-[#E14C55]/35 bg-[#E14C55]/10 text-[#E14C55]',
            )}
          >
            <span className={cn('size-1.5 rounded-full', live ? 'bg-[#307DFD]' : 'bg-[#E14C55]')} aria-hidden="true" />
            {feedLabel}
          </span>
        </div>

        <div className="flex w-full shrink-0 items-start justify-end gap-3 xl:ml-auto xl:w-auto">
          <NotificationCenter />
          <TimezoneClock />
        </div>
      </div>

      {/* A description list: each Stat renders dt/dd, which must live inside a dl. */}
      <dl className="flex flex-col gap-4 lg:flex-row lg:items-stretch lg:gap-[26px]">
        {/* Zone A — how much money */}
        <MetricCard className="lg:basis-[42%] lg:shrink-0">
          {/* soft fill behind the planet limb */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{ background: 'radial-gradient(120% 130% at 100% 125%, rgba(56,116,214,0.40), transparent 62%)' }}
          />
          {/* planet limb, clipped by the card edge */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-[38%] -bottom-[70%] aspect-square w-[125%] rounded-full"
            style={{ background:
              'radial-gradient(circle at 50% 50%, #080E1C 0 58%, rgba(150,200,255,0.65) 60.5%, rgba(70,130,215,0.25) 65%, transparent 72%)' }}
          />
          <div className="relative">
            <Stat
              label="EQUITY"
              value={formatUsd(snapshot.equity)}
              tone={snapshot.floatingPnl >= 0 ? 'primary' : 'danger'}
              size="hero"
              icon={<Scale className="size-4 text-[#307DFD]" aria-hidden="true" />}
            />
            <div className="mt-4 flex items-stretch border-t border-white/[0.07] pt-4">
              <div className="min-w-0 flex-1 pr-4">
                <Stat label="BALANCE" value={formatUsd(snapshot.balance)} size="sm" />
              </div>
              <div className="w-px shrink-0 bg-white/[0.07]" aria-hidden="true" />
              <div className="min-w-0 flex-1 pl-4">
                <Stat label="FREE MARGIN" value={formatUsd(snapshot.freeMargin)} size="sm" />
              </div>
            </div>
          </div>
        </MetricCard>

        {/* Zone B — how much is used */}
        <MetricCard className="lg:basis-[11.5%] lg:shrink-0">
          <Stat
            label="MARGIN"
            value={formatUsd(snapshot.marginUsed)}
            size="md"
            icon={<BarChart3 className="size-4 text-[#307DFD]" aria-hidden="true" />}
          />
        </MetricCard>

        {/* Zone C — how much is left before breach */}
        <MetricCard className="lg:flex-1">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-[#307DFD]" aria-hidden="true" />
              <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-[#8FA3C4]">DAILY DD BUFFER</span>
            </div>
            <div className="flex items-center gap-4 font-mono tabular-nums">
              <span className="text-base font-bold text-[#F4F7FF]">{formatUsd(snapshot.dailyBufferUsd)}</span>
              <span
                className={cn(
                  'text-[11px] uppercase tracking-[0.08em]',
                  ddRatio >= 0.8 ? 'text-[#E14C55]' : ddRatio >= 0.5 ? 'text-warning' : 'text-[#8FA3C4]',
                )}
              >
                {Math.round(ddRatio * 100)}% used
              </span>
            </div>
          </div>
          <div
            className="mt-3 h-2.5 overflow-hidden rounded-full bg-[#101A2E]"
            role="meter"
            aria-label="Daily drawdown buffer remaining"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((1 - ddRatio) * 100)}
          >
            <div
              className={cn(
                'h-full rounded-full transition-[width]',
                ddRatio >= 0.8 ? 'bg-[#E14C55]' : ddRatio >= 0.5 ? 'bg-warning' : 'bg-[#307DFD]',
              )}
              style={{ width: `${Math.max(4, (1 - ddRatio) * 100)}%` }}
            />
          </div>
        </MetricCard>
      </dl>
    </div>
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
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="flex h-[52px] w-[210px] shrink-0 items-center justify-between gap-2 rounded-xl border border-white/[0.08] bg-[#0B1224] px-3.5 text-left transition-colors hover:border-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#307DFD]/50"
          />
        }
      >
        <span className="flex min-w-0 flex-col leading-none">
          <span className="text-[10px] uppercase tracking-[0.08em] text-[#8FA3C4]">Symbol</span>
          <span className="mt-1 truncate text-[15px] font-semibold text-[#F4F7FF]">{getSymbol(selectedSymbol).displayName}</span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-[#8FA3C4]" aria-hidden="true" />
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
        render={
          <button
            type="button"
            className="flex h-[52px] w-[170px] shrink-0 items-center justify-between gap-2 rounded-xl border border-white/[0.08] bg-[#0B1224] px-3 text-left transition-colors hover:border-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#307DFD]/50"
          />
        }
        aria-label={`Terminal time ${time} ${label}. Change timezone`}>
        <Clock className="size-4 shrink-0 text-[#307DFD]" aria-hidden="true" />
        <span className="flex min-w-0 flex-col leading-none">
          <span className="truncate text-[10px] uppercase tracking-[0.08em] text-[#8FA3C4]">
            {timeZoneOffsetLabel(timeZone)}
          </span>
          <span className="mt-1 whitespace-nowrap font-mono text-[14px] font-semibold tabular-nums text-[#F4F7FF]">
            {time} <span className="text-[11px] font-normal text-[#8FA3C4]">{date}</span>
          </span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-[#8FA3C4]" aria-hidden="true" />
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

function QuoteStack({ label, value, tone }: { label: string; value: string; tone: 'primary' | 'danger' | 'normal' }) {
  return (
    <div className="px-4 first:pl-0">
      <p className="text-[10px] uppercase tracking-[0.08em] text-[#8FA3C4]">{label}</p>
      <p
        className={cn(
          'mt-0.5 font-mono text-[15px] font-semibold tabular-nums',
          tone === 'primary' ? 'text-[#307DFD]' : tone === 'danger' ? 'text-[#E14C55]' : 'text-[#F4F7FF]',
        )}
      >
        {value}
      </p>
    </div>
  )
}

function QuoteDelta({ value, up }: { value: string; up: boolean }) {
  return <p className={cn('mt-0.5 font-mono text-[15px] font-semibold tabular-nums', up ? 'text-[#307DFD]' : 'text-[#E14C55]')}>{value}</p>
}

/** Status chip — moved to row 1 per the terminal header spec. */
function StatusChip({ status }: { status: string }) {
  const active = status === 'ACTIVE'
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.06em]',
        active ? 'border-[#307DFD]/35 bg-[#307DFD]/10 text-[#307DFD]' : 'border-[#E14C55]/35 bg-[#E14C55]/10 text-[#E14C55]',
      )}
      aria-label={`Account status: ${status}`}
    >
      <span className="relative flex size-1.5" aria-hidden="true">
        {active ? (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#307DFD] opacity-60 motion-reduce:animate-none" />
        ) : null}
        <span className={cn('relative inline-flex size-1.5 rounded-full', active ? 'bg-[#307DFD]' : 'bg-[#E14C55]')} />
      </span>
      {status}
    </span>
  )
}

function MetricCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn(
      'relative min-w-0 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#080E1C] px-6 py-5',
      className,
    )}>
      {children}
    </div>
  )
}

/**
 * A single header metric with an explicit accent level.
 * `size="hero"` is used for Equity; `size="md"` for Margin; `size="sm"` for the sub-stats.
 */
function Stat({ label, value, tone = 'normal', size = 'sm', icon }: {
  label: string
  value: string
  tone?: 'normal' | 'primary' | 'danger' | 'muted' | 'warning'
  size?: 'sm' | 'md' | 'hero'
  icon?: ReactNode
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.1em] text-[#8FA3C4]">
        {icon}
        {label}
      </dt>
      <dd
        className={cn(
          'mt-1 font-mono tabular-nums',
          size === 'hero'
            ? 'text-[40px] leading-[1.1] font-semibold'
            : size === 'md'
              ? 'text-[22px] font-semibold'
              : 'text-base font-semibold',
          tone === 'primary' ? 'text-[#307DFD]' : tone === 'danger' ? 'text-[#E14C55]' : tone === 'warning' ? 'text-warning' : 'text-[#F4F7FF]',
        )}
      >
        {value}
      </dd>
    </div>
  )
}
