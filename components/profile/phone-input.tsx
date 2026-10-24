'use client'

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import {
  COUNTRY_OPTIONS,
  countryByCode,
  formatNationalNumber,
  isPhoneValid,
  nationalDigits,
  phonePreview,
  type CountryOption,
} from '@/lib/countries'
import { cn } from '@/lib/utils'

export function PhoneInput({
  country,
  onCountryChange,
  value,
  onChange,
  error,
}: {
  country: string
  onCountryChange: (code: string) => void
  value: string
  onChange: (digits: string) => void
  error?: string | null
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const selected = countryByCode(country)

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return COUNTRY_OPTIONS
    return COUNTRY_OPTIONS.filter((item) =>
      `${item.name} ${item.code} ${item.dialCode}`.toLowerCase().includes(normalized),
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

  function choose(item: CountryOption) {
    onCountryChange(item.code)
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
      const item = results[highlighted]
      if (item) choose(item)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
    }
  }

  const valid = value.length > 0 && isPhoneValid(selected?.code ?? null, value)
  const preview = value ? phonePreview(selected?.code ?? null, value) : ''

  return (
    <div ref={rootRef} className="relative sm:col-span-2">
      <label htmlFor="phone-national" className="text-sm text-slate-300">
        Phone number
      </label>
      <div
        className={cn(
          'mt-2 flex h-11 w-full overflow-hidden rounded-lg border border-white/10 bg-[#090d12] transition',
          'focus-within:border-lime-400/70 focus-within:ring-2 focus-within:ring-lime-400/10',
          error && 'border-rose-400/50',
        )}
      >
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label="Select phone country code"
          onClick={() => setOpen((current) => !current)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              setOpen(true)
            }
          }}
          className="flex shrink-0 items-center gap-2 border-r border-white/10 px-3 text-sm text-white outline-none hover:bg-white/[0.04]"
        >
          <span aria-hidden="true" className="text-base leading-none">{selected?.flag ?? '🌐'}</span>
          <span className="font-mono text-slate-300">{selected?.dialCode ?? '+'}</span>
          <ChevronDown className={cn('size-3.5 text-slate-500 transition', open && 'rotate-180')} />
        </button>
        <input
          id="phone-national"
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          value={formatNationalNumber(selected?.code ?? null, value)}
          onChange={(event) => onChange(nationalDigits(event.target.value))}
          maxLength={18}
          placeholder="99 123 4567"
          className="h-full min-w-0 flex-1 bg-transparent px-3 text-sm text-white outline-none placeholder:text-slate-600"
        />
        {valid && <Check className="mr-3 size-4 self-center text-lime-300" aria-label="Valid phone number" />}
      </div>

      <div className="mt-1.5 min-h-4 text-xs">
        {value && !valid && <span className="text-rose-300">Enter a valid phone number for the selected country.</span>}
        {valid && preview && <span className="text-slate-500">International: <span className="text-slate-300">{preview}</span></span>}
        {!value && <span className="text-slate-500">Digits only; the country code is stored separately.</span>}
        {error && !value && <span className="text-rose-300">{error}</span>}
      </div>

      {open && (
        <div className="absolute z-50 mt-2 w-[min(22rem,calc(100vw-3rem))] overflow-hidden rounded-xl border border-lime-300/20 bg-[#0b1117]/95 shadow-[0_24px_70px_-28px_rgba(0,0,0,0.9)] backdrop-blur-xl">
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
                placeholder="Search code or country…"
                className="h-9 w-full rounded-lg border border-white/10 bg-black/20 pr-3 pl-8 text-sm text-white outline-none placeholder:text-slate-600 focus:border-lime-400/60"
                aria-label="Search phone country code"
              />
            </div>
          </div>
          <ul role="listbox" className="max-h-72 overflow-y-auto p-1">
            {results.length === 0 && <li className="px-3 py-4 text-center text-sm text-slate-500">No country found</li>}
            {results.map((item, index) => (
              <li
                key={item.code}
                role="option"
                aria-selected={item.code === selected?.code}
                onPointerDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => choose(item)}
                className={cn(
                  'flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-slate-300',
                  index === highlighted && 'bg-lime-300/10 text-white',
                  item.code === selected?.code && 'text-lime-200',
                )}
              >
                <span aria-hidden="true" className="w-5 text-base leading-none">{item.flag}</span>
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span className="text-xs text-slate-500">{item.dialCode}</span>
                {item.code === selected?.code && <Check className="size-4 text-lime-300" />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
