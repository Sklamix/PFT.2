'use client'

import { ArrowUpRight, BadgeCheck } from 'lucide-react'

import { trackEvent } from '@/lib/analytics/track'
import { usePublicStats } from '@/lib/stats/use-public-stats'

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

/**
 * Live proof line for the hero.
 *
 * Every figure here is an aggregate of real `PayoutProof` rows, never the
 * `platformStats` counters and never a placeholder: those counters can carry a
 * hand-entered baseline that no individual payout backs up. Before the first
 * published payout there is nothing truthful to put here, so the bar stays absent
 * instead of printing zeroes.
 */
export function HeroProofBar() {
  const { proofs, source } = usePublicStats()

  if (source !== 'database' || proofs.count === 0) return null

  const segments = [
    proofs.total > 0 ? `${usd.format(proofs.total)} paid out` : null,
    `${proofs.count} ${proofs.count === 1 ? 'payout' : 'payouts'}`,
  ].filter((segment): segment is string => segment !== null)

  return (
    <div className="col-span-full flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl border border-white/10 bg-black/20 px-[clamp(0.6rem,0.9vw,0.95rem)] py-[clamp(0.35rem,0.5vw,0.55rem)] backdrop-blur-md">
      <BadgeCheck className="size-[clamp(0.85rem,1vw,1.05rem)] shrink-0 text-highlight" aria-hidden="true" />
      <p className="font-mono text-[clamp(0.6rem,0.72vw,0.8rem)] tabular-nums text-white">
        {segments.join(' · ')}
      </p>
      <a
        href="#payouts"
        onClick={() => trackEvent('proof_verify_click', { from: 'hero' })}
        className="ml-auto inline-flex items-center gap-1 text-[clamp(0.55rem,0.66vw,0.72rem)] uppercase tracking-[0.14em] text-muted-foreground underline-offset-4 transition hover:text-foreground hover:underline"
      >
        Verify
        <ArrowUpRight className="size-3" aria-hidden="true" />
      </a>
    </div>
  )
}
