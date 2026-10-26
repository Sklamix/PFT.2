'use client'

import { useCallback, useEffect, useState } from 'react'
import { BadgeCheck } from 'lucide-react'
import { SectionHeading } from '@/components/section-heading'
import { FALLBACK_PUBLIC_STATS } from '@/lib/stats/defaults'
import type { PublicPayout, PublicStatsPayload } from '@/lib/stats/types'

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

const compactUsd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
})

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function formatRewards(value: number) {
  return `${compactUsd.format(value)}+`
}

function formatAvgPayout(hours: number) {
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hrs`
}

function PayoutCard({ payout, duplicate }: { payout: PublicPayout; duplicate?: boolean }) {
  return (
    <li
      aria-hidden={duplicate || undefined}
      className="home-card group relative flex w-[19rem] shrink-0 items-center gap-3.5 overflow-hidden rounded-2xl border border-white/10 bg-[#07101c]/70 px-4 py-4 backdrop-blur-xl sm:w-[20rem]"
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
  const { stats, payouts } = usePublicStats()
  const cards = payouts.slice(0, 12)
  const repeatCount = cards.length ? Math.max(1, Math.ceil(8 / cards.length)) : 0
  const repeated = Array.from({ length: repeatCount }, () => cards).flat()
  const marquee = [...repeated, ...repeated]

  const tiles = [
    { value: formatRewards(stats.totalRewardsPaid), label: 'Total rewards paid' },
    { value: `${integer.format(stats.fundedTradersCount)}+`, label: 'Funded traders' },
    { value: formatAvgPayout(stats.avgPayoutTimeHours), label: 'Avg. payout time' },
    { value: `${integer.format(stats.countriesServedCount)}+`, label: 'Countries served' },
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
            eyebrow="Payout proofs"
            title="Verified rewards, paid every day."
            description="Real performance rewards to funded traders — settled in crypto or by bank wire."
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

        <div className="mt-10 flex items-center justify-between gap-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">Recent payouts</p>
          <p className="hidden items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-slate-600 sm:flex">
            <span className="size-1.5 rounded-full bg-highlight" />
            Crypto · bank wire
          </p>
        </div>
      </div>

      {marquee.length > 0 ? (
        <div className="relative mt-4 overflow-hidden mask-[linear-gradient(to_right,transparent,#000_8%,#000_92%,transparent)]">
          <ul className="animate-marquee flex w-max gap-3.5" aria-label="Recent payouts">
            {marquee.map((payout, index) => (
              <PayoutCard key={`${payout.id}-${index}`} payout={payout} duplicate={index >= repeated.length} />
            ))}
          </ul>
        </div>
      ) : (
        <div className="relative mx-4 mt-4 rounded-2xl border border-white/10 bg-white/[0.025] px-5 py-8 text-center text-sm text-slate-500 sm:mx-6 lg:mx-8">
          No payouts have been published yet.
        </div>
      )}
    </section>
  )
}
