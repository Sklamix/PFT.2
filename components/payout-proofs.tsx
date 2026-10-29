'use client'

import { useCallback, useEffect, useState } from 'react'
import { BadgeCheck } from 'lucide-react'
import { SectionHeading } from '@/components/section-heading'
import { FALLBACK_PUBLIC_STATS } from '@/lib/stats/defaults'
import type { PublicPayout, PublicStatsPayload } from '@/lib/stats/types'
import { cn } from '@/lib/utils'

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

const compactUsd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 2,
})

function PayoutCard({
  payout,
  duplicate,
  fluid,
}: {
  payout: PublicPayout
  duplicate?: boolean
  fluid?: boolean
}) {
  return (
    <li
      aria-hidden={duplicate || undefined}
      className={cn(
        'home-card group relative flex items-center gap-3.5 overflow-hidden rounded-2xl border border-white/10 bg-[#07101c]/70 px-4 py-4 backdrop-blur-xl',
        fluid ? 'w-full' : 'w-[19rem] shrink-0 sm:w-[20rem]',
      )}
    >
      <span className="pointer-events-none absolute inset-x-6 top-0 h-px bg-linear-to-r from-transparent via-primary/70 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-primary/25 bg-primary/10 font-mono text-[11px] text-primary shadow-[inset_0_0_20px_rgba(59,130,246,0.14)]">
        {payout.countryCode}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 text-sm font-semibold text-white">
          {payout.traderName}
          <BadgeCheck className="size-3.5 text-highlight" aria-label="Verified payout" />
        </p>
        <p className="mt-0.5 truncate text-[11px] text-slate-500">
          {compactUsd.format(payout.accountSize)} account · {payout.payoutMethod}
        </p>
      </div>
      <div className="text-right">
        <p className="font-mono text-[15px] font-semibold tabular-nums text-highlight">{usd.format(payout.payoutAmount)}</p>
        <p className="mt-0.5 text-[9px] uppercase tracking-[0.18em] text-slate-600">paid</p>
      </div>
    </li>
  )
}

function usePublicStats() {
  const [payload, setPayload] = useState<PublicStatsPayload>(FALLBACK_PUBLIC_STATS)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/stats', { cache: 'no-store' })
      if (!response.ok) return
      const next = (await response.json()) as PublicStatsPayload
      if (next?.stats && Array.isArray(next.payouts)) setPayload(next)
    } catch {
      // Keep the last successful snapshot; the bundled fallback is used on first load.
    }
  }, [])

  useEffect(() => {
    void load()
    const interval = window.setInterval(() => void load(), 60_000)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load])

  return payload
}

export function PayoutProofs() {
  const { payouts } = usePublicStats()
  const cards = payouts.slice(0, 12)
  const useMarquee = cards.length >= 5
  const marquee = [...cards, ...cards]

  // Real, verifiable platform facts — no fabricated social proof.
  const tiles = [
    { value: '$200K', label: 'Max simulated capital' },
    { value: '80%', label: 'Profit split' },
    { value: '7 days', label: 'Payout cycle' },
    { value: '0', label: 'Time limits' },
  ]

  return (
    <section
      id="payouts"
      aria-labelledby="payouts-heading"
      data-home-reveal
      className="relative overflow-hidden border-b border-white/5 py-16 sm:py-20"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_-20%,rgba(37,99,235,0.18),transparent_58%)]" />
      <div className="pointer-events-none absolute -left-48 top-0 size-[28rem] rounded-full bg-primary/10 blur-[110px]" />
      <div className="pointer-events-none absolute inset-0 cosmic-stars opacity-60" />

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 2xl:max-w-[1600px]">
        <div className="flex flex-col gap-9 lg:flex-row lg:items-end lg:justify-between">
          <SectionHeading
            id="payouts-heading"
            eyebrow="The PFT standard"
            title="Clear terms. No fine print."
            description="Simulated capital, a transparent profit split, weekly payouts and no time limits — the same conditions for every trader."
            align="left"
          />
          <dl className="grid w-full grid-cols-2 gap-2.5 sm:grid-cols-4 lg:w-auto lg:min-w-[560px]">
            {tiles.map((tile) => (
              <div
                key={tile.label}
                className="relative flex flex-col-reverse gap-1 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3.5 backdrop-blur-md"
              >
                <span className="absolute top-3.5 right-3.5 size-1.5 rounded-full bg-primary shadow-[0_0_10px_2px_rgba(59,130,246,0.45)]" />
                <dt className="text-[10px] uppercase tracking-[0.14em] text-slate-500">{tile.label}</dt>
                <dd className="font-mono text-[clamp(1.15rem,1.35vw,1.55rem)] font-semibold tabular-nums text-white">
                  {tile.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        {cards.length > 0 ? (
          <>
            <div className="mt-10 flex items-center justify-between gap-4">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">Recent payouts</p>
              <p className="hidden items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-slate-600 sm:flex">
                <span className="size-1.5 rounded-full bg-highlight" />
                Crypto · bank wire
              </p>
            </div>
          </>
        ) : null}
      </div>

      {cards.length === 0 ? null : useMarquee ? (
        <div className="relative mt-4 overflow-hidden mask-[linear-gradient(to_right,transparent,#000_8%,#000_92%,transparent)]">
          <ul className="animate-marquee flex w-max gap-3.5" aria-label="Recent payouts">
            {marquee.map((payout, index) => (
              <PayoutCard key={`${payout.id}-${index}`} payout={payout} duplicate={index >= cards.length} />
            ))}
          </ul>
        </div>
      ) : (
        <div className="relative mx-auto mt-4 max-w-7xl px-4 sm:px-6 lg:px-8 2xl:max-w-[1600px]">
          <ul className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4" aria-label="Recent payouts">
            {cards.map((payout) => (
              <PayoutCard key={payout.id} payout={payout} fluid />
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
