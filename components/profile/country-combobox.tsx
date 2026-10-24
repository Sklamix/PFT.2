'use client'

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { COUNTRY_OPTIONS, countryByValue, type CountryOption } from '@/lib/countries'
import { cn } from '@/lib/utils'

export function CountryCombobox({
  value,
  onChange,
  id = 'country',
  label = 'Country of residence',
  placeholder = 'Search country…',
}: {
  value: string
  onChange: (code: string) => void
  id?: string
  label?: string
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const selected = countryByValue(value)

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return COUNTRY_OPTIONS
    return COUNTRY_OPTIONS.filter((country) =>
      `${country.name} ${country.code} ${country.dialCode}`.toLowerCase().includes(normalized),
    )
  }, [query])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setHighlighted(0)
    const handle = window.setTimeout(() => searchRef.current?.focus(), 30)
    return () => window.clearTimeout(handle)
  }, [open])

  function choose(country: CountryOption) {
    onChange(country.code)
    setOpen(false)
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlighted((current) => Math.min(current + 1, Math.max(0, results.length - 1)))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlighted((current) => Math.max(current - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const country = results[highlighted]
      if (country) choose(country)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <label htmlFor={`${id}-button`} className="text-sm text-slate-300">
        {label}
      </label>
      <button
        id={`${id}-button`}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-listbox`}
        aria-haspopup="listbox"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen(true)
          }
        }}
        className={cn(
          'mt-2 flex h-11 w-full items-center justify-between gap-3 rounded-lg border border-white/10 bg-[#090d12] px-3 text-left text-sm text-white outline-none transition',
          'focus:border-lime-400/70 focus:ring-2 focus:ring-lime-400/10',
          open && 'border-lime-400/70 ring-2 ring-lime-400/10',
        )}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden="true" className="text-base leading-none">
            {selected?.flag ?? '🌐'}
          </span>
          <span className={cn('truncate', !selected && 'text-slate-500')}>
            {selected ? selected.name : 'Select country'}
          </span>
          {selected && <span className="shrink-0 text-xs text-slate-500">{selected.dialCode}</span>}
        </span>
        <ChevronDown className={cn('size-4 shrink-0 text-slate-500 transition', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute z-50 mt-2 w-full overflow-hidden rounded-xl border border-lime-300/20 bg-[#0b1117]/95 shadow-[0_24px_70px_-28px_rgba(0,0,0,0.9)] backdrop-blur-xl">
          <div className="border-b border-white/5 p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-slate-500" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setHighlighted(0)
                }}
                onKeyDown={onSearchKeyDown}
                placeholder={placeholder}
                className="h-9 w-full rounded-lg border border-white/10 bg-black/20 pr-3 pl-8 text-sm text-white outline-none placeholder:text-slate-600 focus:border-lime-400/60"
                aria-label="Search country"
              />
            </div>
          </div>
          <ul id={`${id}-listbox`} role="listbox" className="max-h-72 overflow-y-auto p-1">
            {results.length === 0 && <li className="px-3 py-4 text-center text-sm text-slate-500">No country found</li>}
            {results.map((country, index) => (
              <li
                key={country.code}
                role="option"
                aria-selected={country.code === selected?.code}
                onPointerDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => choose(country)}
                className={cn(
                  'flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-slate-300',
                  index === highlighted && 'bg-lime-300/10 text-white',
                  country.code === selected?.code && 'text-lime-200',
                )}
              >
                <span aria-hidden="true" className="w-5 text-base leading-none">{country.flag}</span>
                <span className="min-w-0 flex-1 truncate">{country.name}</span>
                <span className="text-xs text-slate-500">{country.dialCode}</span>
                {country.code === selected?.code && <Check className="size-4 text-lime-300" />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
