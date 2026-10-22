'use client'

import { useState } from 'react'
import { Plus, Star } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { TIMEFRAMES, type TimeframeSpec } from '@/lib/terminal/candles'
import { useTimeframeStore } from '@/lib/stores/useTimeframeStore'
import { cn } from '@/lib/utils'

const inputClass =
  'h-8 rounded-md border border-input bg-background/70 px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40'

export function TimeframePicker() {
  const favorites = useTimeframeStore((state) => state.favorites)
  const selected = useTimeframeStore((state) => state.selected)
  const select = useTimeframeStore((state) => state.select)
  const toggleFavorite = useTimeframeStore((state) => state.toggleFavorite)
  const addCustom = useTimeframeStore((state) => state.addCustom)
  const [amount, setAmount] = useState('')
  const [unit, setUnit] = useState<'m' | 'h' | 'd'>('m')
  const [error, setError] = useState<string | null>(null)

  function submitCustom() {
    const spec = addCustom(amount, unit)
    if (!spec) {
      setError('Use 1–43200 minutes (or up to 30 days).')
      return
    }
    setAmount('')
    setError(null)
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <div className="flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md border border-border bg-secondary/60 p-0.5" role="tablist" aria-label="Chart timeframe">
        {favorites.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={selected === item.id}
            onClick={() => select(item)}
            className={cn(
              'shrink-0 rounded px-2 py-1 font-mono text-[11px] font-medium transition-colors',
              selected === item.id ? 'bg-background text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="Add timeframe"
              className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-secondary/60 text-muted-foreground transition-colors hover:text-foreground"
            />
          }
        >
          <Plus className="size-3.5" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72 p-0">
          <div className="border-b border-border p-2.5">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Custom timeframe</p>
            <div className="flex items-center gap-1.5">
              <input
                inputMode="numeric"
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value.replace(/[^0-9]/g, ''))
                  setError(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') return
                  event.stopPropagation()
                  if (event.key === 'Enter') submitCustom()
                }}
                placeholder="7"
                aria-label="Custom timeframe amount"
                className={cn(inputClass, 'min-w-0 flex-1')}
              />
              <select
                value={unit}
                onChange={(event) => setUnit(event.target.value as 'm' | 'h' | 'd')}
                aria-label="Custom timeframe unit"
                className={cn(inputClass, 'w-16')}
              >
                <option value="m">min</option>
                <option value="h">hours</option>
                <option value="d">days</option>
              </select>
              <button
                type="button"
                onClick={submitCustom}
                className="h-8 shrink-0 rounded-md border border-primary/40 bg-primary/15 px-2.5 font-mono text-[11px] text-primary transition-colors hover:bg-primary/25"
              >
                Add
              </button>
            </div>
            {error ? <p className="mt-1.5 font-mono text-[10px] text-danger">{error}</p> : null}
          </div>

          <div className="max-h-72 overflow-y-auto p-1">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Favorites
              </DropdownMenuLabel>
              {favorites.map((item) => (
                <TimeframeRow
                  key={item.id}
                  item={item}
                  selected={selected === item.id}
                  favorite
                  onSelect={select}
                  onToggle={toggleFavorite}
                />
              ))}
            </DropdownMenuGroup>

            <DropdownMenuSeparator />

            <DropdownMenuGroup>
              <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Presets
              </DropdownMenuLabel>
              {TIMEFRAMES.map((preset) => {
                const item: TimeframeSpec = { ...preset, custom: false }
                return (
                  <TimeframeRow
                    key={item.id}
                    item={item}
                    selected={selected === item.id}
                    favorite={favorites.some((favorite) => favorite.id === item.id)}
                    onSelect={select}
                    onToggle={toggleFavorite}
                  />
                )
              })}
            </DropdownMenuGroup>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function TimeframeRow({
  item,
  selected,
  favorite,
  onSelect,
  onToggle,
}: {
  item: TimeframeSpec
  selected: boolean
  favorite: boolean
  onSelect: (item: TimeframeSpec) => void
  onToggle: (item: TimeframeSpec) => void
}) {
  return (
    <DropdownMenuItem
      onClick={() => onSelect(item)}
      className={cn('flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 font-mono', selected && 'bg-primary/10')}
    >
      <span className="flex items-center gap-2 text-xs text-foreground">
        {item.label}
        {item.custom ? <span className="text-[9px] uppercase tracking-wide text-muted-foreground">custom</span> : null}
      </span>
      <span
        role="button"
        tabIndex={0}
        aria-label={favorite ? `Remove ${item.label} from favorites` : `Add ${item.label} to favorites`}
        onClick={(event) => {
          event.stopPropagation()
          onToggle(item)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          event.stopPropagation()
          onToggle(item)
        }}
        className="rounded p-0.5 hover:bg-secondary"
      >
        <Star className={cn('size-3.5', favorite ? 'fill-highlight text-highlight' : 'text-muted-foreground')} aria-hidden="true" />
      </span>
    </DropdownMenuItem>
  )
}
