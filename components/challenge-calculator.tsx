'use client'

import { useEffect, useState } from 'react'
import { ArrowRight, Info, ShieldCheck, RotateCcw, Zap } from 'lucide-react'
import { CheckoutModal } from '@/components/checkout-modal'
import { SegmentedControl } from '@/components/segmented-control'
import { SectionHeading } from '@/components/section-heading'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ACCOUNT_TIERS,
  CHALLENGES,
  LEVERAGE,
  UNAVAILABLE_TIER_MESSAGE,
  formatCompact,
  formatCurrency,
  formatPrice,
  STATIC_DRAWDOWN_PREMIUM,
  type AccountSize,
  type ChallengeType,
  type DrawdownMode,
} from '@/lib/challenges'
import { cn } from '@/lib/utils'

const TYPE_OPTIONS = [
  { value: 'one-step', label: '1-Step Challenge' },
  { value: 'two-step', label: '2-Step Evaluation' },
] as const satisfies readonly { value: ChallengeType; label: string }[]

const DRAWDOWN_OPTIONS = [
  { value: 'trailing', label: 'Trailing' },
  { value: 'static', label: 'Static' },
] as const satisfies readonly { value: DrawdownMode; label: string }[]

interface MetricRowProps {
  label: string
  hint: string
  value: string
  subValue?: string
  muted?: boolean
}

function MetricRow({ label, hint, value, subValue, muted }: MetricRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 py-4">
      <div className="flex items-center gap-1.5">
        <dt className="text-sm text-slate-400">{label}</dt>
        <Tooltip>
          <TooltipTrigger
            className="rounded text-slate-600 transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label={`About ${label}`}
          >
            <Info className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>{hint}</TooltipContent>
        </Tooltip>
      </div>
      <dd className="text-right">
        <span className={muted ? 'font-mono text-sm text-slate-500' : 'font-mono text-base font-semibold tabular-nums text-white'}>
          {value}
        </span>
        {subValue && <span className="block font-mono text-xs tabular-nums text-slate-500">{subValue}</span>}
      </dd>
    </div>
  )
}

export function ChallengeCalculator({
  presentation = 'page',
  customer,
}: {
  presentation?: 'page' | 'embedded'
  customer?: { email: string; name?: string }
}) {
  const [size, setSize] = useState<AccountSize>(10_000)
  const [type, setType] = useState<ChallengeType>('two-step')
  const [drawdownMode, setDrawdownMode] = useState<DrawdownMode>('trailing')
  const [dailyLossType, setDailyLossType] = useState<3 | 5>(3)
  const [pricing, setPricing] = useState<Record<string, number> | null>(null)
  const [pricingError, setPricingError] = useState<string | null>(null)
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    fetch('/api/pricing', { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Unable to load challenge prices.')
        const current: Record<string, number> = {}
        for (const row of data.prices as Array<{
          accountSize: number
          challengeType: '1-STEP' | '2-STEP'
          dailyLossType: number
          price: number
        }>) {
          if (Number.isInteger(row.price)) {
            current[`${row.challengeType}-${row.accountSize}-${row.dailyLossType}`] = row.price
          }
        }
        if (active) setPricing(current)
      })
      .catch((error: unknown) => {
        if (active) setPricingError(error instanceof Error ? error.message : 'Unable to load challenge prices.')
      })
    return () => {
      active = false
    }
  }, [])

  const rules = CHALLENGES[type]
  const pricingChallengeType = type === 'one-step' ? '1-STEP' : '2-STEP'
  const basePrice = type === 'two-step'
    ? pricing?.[`2-STEP-${size}-${dailyLossType}`]
    : pricing?.[`1-STEP-${size}-4`]
  const fee = basePrice == null
    ? null
    : Math.round(basePrice * (drawdownMode === 'static' ? 1 + STATIC_DRAWDOWN_PREMIUM : 1))
  const phase1Amount = (size * rules.phase1Target) / 100
  const phase2Amount = rules.phase2Target ? (size * rules.phase2Target) / 100 : null
  const activeDailyLoss = type === 'two-step' ? dailyLossType : rules.dailyDrawdown
  const dailyAmount = (size * activeDailyLoss) / 100
  const overallAmount = (size * rules.overallDrawdown) / 100
  const projectedPayout = phase1Amount * 0.9

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4200)
    return () => window.clearTimeout(timer)
  }, [toast])

  function handleTierSelect(nextSize: AccountSize, available: boolean) {
    if (!available) {
      setToast(UNAVAILABLE_TIER_MESSAGE)
      return
    }
    setSize(nextSize)
  }

  function openCheckout() {
    const selected = ACCOUNT_TIERS.find((tier) => tier.size === size)
    if (!selected?.isAvailable) {
      setToast(UNAVAILABLE_TIER_MESSAGE)
      return
    }
    if (fee == null) {
      setToast(pricingError || 'Challenge prices are still loading. Please try again.')
      return
    }
    setCheckoutOpen(true)
  }

  if (presentation === 'embedded' && checkoutOpen && fee != null) {
    return (
      <section className="animate-step-in mx-auto w-full max-w-5xl py-4">
        <CheckoutModal
          open={checkoutOpen}
          onOpenChange={setCheckoutOpen}
          accountSize={size}
          evaluationType={type}
          calculatedPrice={fee}
          drawdownMode={drawdownMode}
          dailyLossType={dailyLossType}
          customer={customer}
          presentation="inline"
        />
      </section>
    )
  }

  return (
    <section
      id={presentation === 'page' ? 'challenges' : undefined}
      aria-labelledby={presentation === 'page' ? 'challenges-heading' : undefined}
      data-home-reveal={presentation === 'page' ? true : undefined}
      className={presentation === 'page' ? 'relative overflow-hidden border-b border-white/5 py-24 sm:py-32' : 'w-full py-3'}
    >
      {presentation === 'page' && (
        <>
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(37,99,235,0.16),transparent_52%)]" />
          <div className="pointer-events-none absolute top-20 -right-52 size-[34rem] rounded-full border border-primary/10" />
          <div className="pointer-events-none absolute -top-36 right-[6%] size-[26rem] rounded-full border border-highlight/10" />
          <div className="pointer-events-none absolute -left-40 bottom-10 size-96 rounded-full bg-primary/10 blur-[120px]" />
          <div className="pointer-events-none absolute inset-0 cosmic-stars opacity-50" />
        </>
      )}
      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 2xl:max-w-[1600px]">
        {presentation === 'page' && (
          <SectionHeading
            id="challenges-heading"
            eyebrow="Challenge matrix"
            title="Pick your capital. Pick your path."
            description="Configure your evaluation and see every rule upfront. One-time fee. No subscription. Evaluation fee is non-refundable."
          />
        )}

        <div
          className={cn(
            'home-card relative overflow-hidden rounded-[2rem] border border-white/10 bg-[#060d19]/80 shadow-[0_40px_120px_-60px_rgba(59,130,246,0.65)] backdrop-blur-2xl',
            presentation === 'page' && 'mt-14',
          )}
        >
          <span className="pointer-events-none absolute inset-x-12 top-0 h-px bg-linear-to-r from-transparent via-primary/70 to-transparent" />
          <div className="grid gap-6 border-b border-white/10 p-5 sm:p-7 lg:grid-cols-[1fr_auto]">
            <div>
              <p className="mb-2.5 font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">
                Account size
              </p>
              <div
                role="radiogroup"
                aria-label="Account size"
                className="grid grid-cols-2 gap-2 sm:grid-cols-4"
              >
                {ACCOUNT_TIERS.map((tier) => {
                  const selected = size === tier.size
                  const selectedLoss = type === 'two-step' ? dailyLossType : 4
                  const tierBasePrice = pricing?.[`${pricingChallengeType}-${tier.size}-${selectedLoss}`]
                  const feeForTier = tierBasePrice == null
                    ? null
                    : Math.round(tierBasePrice * (drawdownMode === 'static' ? 1 + STATIC_DRAWDOWN_PREMIUM : 1))
                  return (
                    <button
                      key={tier.size}
                      type="button"
                      role="radio"
                      aria-checked={selected && tier.isAvailable}
                      aria-disabled={!tier.isAvailable}
                      onClick={() => handleTierSelect(tier.size, tier.isAvailable)}
                      className={cn(
                        'home-price-card relative rounded-xl border px-3.5 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                        tier.isAvailable
                          ? selected
                            ? 'border-primary/60 bg-primary/15 shadow-[inset_0_0_0_1px_rgba(59,130,246,0.45),0_0_30px_-16px_rgba(59,130,246,0.9)]'
                            : 'border-white/10 bg-white/[0.025] hover:border-primary/35 hover:bg-white/[0.05]'
                          : 'cursor-not-allowed border-white/5 bg-white/[0.015] opacity-55',
                      )}
                    >
                      {!tier.isAvailable && (
                        <span className="absolute top-2 right-2 rounded-full border border-white/10 bg-black/40 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-wide text-slate-500">
                          Coming soon
                        </span>
                      )}
                      <span className="home-price-value block font-mono text-[15px] font-semibold tabular-nums text-white transition-colors">
                        {formatCompact(tier.size).replace('K', 'k')}
                      </span>
                      <span className="mt-1 block font-mono text-xs tabular-nums text-slate-500">
                        {feeForTier == null ? (tier.isAvailable ? 'Loading…' : '—') : formatPrice(feeForTier)}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
            <div>
              <p className="mb-2.5 font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">Evaluation type</p>
              <SegmentedControl label="Evaluation type" options={TYPE_OPTIONS} value={type} onChange={setType} />
            </div>
          </div>

          <div className="grid lg:grid-cols-[1fr_400px]">
            <div className="p-5 sm:p-7">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-lg font-semibold text-white sm:text-xl">
                  {formatCurrency(size)} · {rules.label}
                </h3>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                  <span className="size-1.5 rounded-full bg-primary shadow-[0_0_8px_1px_rgba(59,130,246,0.6)]" />
                  Instant credentials
                </span>
              </div>

              <dl className="mt-5 divide-y divide-white/[0.07]">
                <MetricRow
                  label="Phase 1 profit target"
                  hint="Reach this closed profit on your account balance to pass Phase 1."
                  value={`${rules.phase1Target}%`}
                  subValue={formatCurrency(phase1Amount)}
                />
                {rules.phase2Target != null && (
                  <MetricRow
                    label="Phase 2 profit target"
                    hint="The verification phase."
                    value={`${rules.phase2Target}%`}
                    subValue={phase2Amount ? formatCurrency(phase2Amount) : undefined}
                  />
                )}
                <MetricRow
                  label="Max daily drawdown"
                  hint="Measured from the higher of balance or equity at 00:00 server time (CE(S)T)."
                  value={`${activeDailyLoss}%`}
                  subValue={formatCurrency(dailyAmount)}
                />
                {type === 'two-step' && (
                  <div className="flex flex-wrap items-center justify-between gap-3 py-4">
                    <span className="text-sm text-slate-400">Daily loss limit · 2-Step</span>
                    <div className="flex gap-2" role="group" aria-label="Daily loss limit">
                      {([3, 5] as const).map((limit) => (
                        <button
                          key={limit}
                          type="button"
                          aria-pressed={dailyLossType === limit}
                          onClick={() => setDailyLossType(limit)}
                          className={cn(
                            'rounded-full border px-3 py-1.5 text-sm transition-colors',
                            dailyLossType === limit
                              ? 'border-primary/50 bg-primary/10 text-primary'
                              : 'border-white/10 bg-white/[0.025] text-slate-500 hover:bg-white/[0.05] hover:text-white',
                          )}
                        >
                          {limit}% ·                           {pricing?.[`2-STEP-${size}-${limit}`] == null
                            ? '…'
                            : formatPrice(pricing[`2-STEP-${size}-${limit}`])}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-1.5">
                    <dt className="text-sm text-slate-400">Max overall drawdown</dt>
                    <Tooltip>
                      <TooltipTrigger
                        className="rounded text-slate-600 transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        aria-label="About max overall drawdown"
                      >
                        <Info className="size-3.5" />
                      </TooltipTrigger>
                      <TooltipContent>
                        Trailing keeps a fixed 6% / 10% buffer below your equity high-water mark; the floor only moves
                        up. Static stays fixed below your initial balance.
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <dd className="flex items-center justify-between gap-4 sm:justify-end">
                    <SegmentedControl
                      label="Drawdown type"
                      options={DRAWDOWN_OPTIONS}
                      value={drawdownMode}
                      onChange={setDrawdownMode}
                      size="sm"
                      className="w-40"
                    />
                    <span className="text-right">
                      <span className="font-mono text-base font-semibold tabular-nums text-white">
                        {rules.overallDrawdown}%
                      </span>
                      <span className="block font-mono text-xs tabular-nums text-slate-500">
                        {formatCurrency(overallAmount)}
                      </span>
                    </span>
                  </dd>
                </div>
                <div className="py-4">
                  <dt className="text-sm text-slate-400">Leverage</dt>
                  <dd className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {LEVERAGE.map((item) => (
                      <div key={item.market} className="rounded-xl border border-white/10 bg-white/[0.025] px-3 py-2.5">
                        <p className="text-[10px] uppercase tracking-[0.12em] text-slate-500">{item.market}</p>
                        <p className="mt-0.5 font-mono text-sm font-semibold text-white">{item.value}</p>
                      </div>
                    ))}
                  </dd>
                </div>
              </dl>
            </div>

            <aside
              aria-label="Checkout summary"
              className="relative flex flex-col overflow-hidden border-t border-white/10 bg-[radial-gradient(ellipse_at_50%_0%,rgba(59,130,246,0.16),transparent_62%)] p-5 sm:p-7 lg:border-t-0 lg:border-l"
            >
              <div className="pointer-events-none absolute -top-16 left-1/2 size-48 -translate-x-1/2 rounded-full bg-primary/15 blur-[70px]" />
              <div className="relative">
                <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">One-time evaluation fee</p>
                <p className="mt-2 flex items-baseline gap-2" aria-live="polite">
                  <span className="font-mono text-[clamp(2.8rem,4vw,3.6rem)] font-semibold leading-none tracking-tight tabular-nums text-white drop-shadow-[0_0_28px_rgba(59,130,246,0.35)]">
                    {fee == null ? '—' : formatPrice(fee)}
                  </span>
                  <span className="text-sm text-slate-500">USD</span>
                </p>
                {pricingError && (
                  <p role="alert" className="mt-2 text-sm text-destructive">{pricingError}</p>
                )}
                <p className="mt-2 text-sm text-slate-400">
                  {drawdownMode === 'static' ? 'Includes static drawdown upgrade.' : 'Trailing drawdown — best value.'}
                </p>

                <div className="mt-6 rounded-2xl border border-primary/20 bg-primary/[0.07] p-4">
                  <p className="text-xs text-slate-400">Projected first payout at Phase 1 target</p>
                  <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-highlight">
                    {formatCurrency(projectedPayout)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">Based on an 80% profit split</p>
                </div>

                <ul className="mt-6 flex flex-col gap-3 text-sm">
                  <li className="flex items-center gap-2.5 text-slate-300">
                    <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
                    80% profit split
                  </li>
                  <li className="flex items-center gap-2.5 text-slate-300">
                    <RotateCcw className="size-4 text-primary" aria-hidden="true" />
                    Fee is non-refundable
                  </li>
                  <li className="flex items-center gap-2.5 text-slate-300">
                    <Zap className="size-4 text-primary" aria-hidden="true" />
                    Min. {rules.minTradingDays} trading days · no maximum
                  </li>
                </ul>

                <button
                  type="button"
                  onClick={openCheckout}
                  disabled={fee == null}
                  className="home-button group mt-8 inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-linear-to-r from-primary to-highlight px-6 text-[11px] font-bold uppercase tracking-[0.16em] text-primary-foreground shadow-[0_0_45px_-12px_rgba(59,130,246,0.9)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 lg:mt-8"
                >
                  Start Challenge — {fee == null ? 'Loading price…' : formatPrice(fee)}
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                </button>
                <p className="mt-3 text-center text-xs text-slate-500">Card, Apple Pay & crypto accepted</p>
              </div>
            </aside>
          </div>
        </div>
      </div>

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed right-4 bottom-4 z-[90] max-w-sm rounded-2xl border border-white/10 bg-[#07101c]/95 px-4 py-3 text-sm text-white shadow-[0_16px_48px_-20px_rgba(59,130,246,0.55)] backdrop-blur-xl"
        >
          {toast}
        </div>
      )}

      {presentation === 'page' && (
        <CheckoutModal
          open={checkoutOpen}
          onOpenChange={setCheckoutOpen}
          accountSize={size}
          evaluationType={type}
          calculatedPrice={fee ?? 0}
          drawdownMode={drawdownMode}
          dailyLossType={dailyLossType}
          customer={customer}
        />
      )}
    </section>
  )
}
