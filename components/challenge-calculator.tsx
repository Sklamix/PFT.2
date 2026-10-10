'use client'

import { useState } from 'react'
import { ArrowRight, Info, ShieldCheck, RotateCcw, Zap } from 'lucide-react'
import { SegmentedControl } from '@/components/segmented-control'
import { SectionHeading } from '@/components/section-heading'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ACCOUNT_SIZES,
  CHALLENGES,
  LEVERAGE,
  formatCompact,
  formatCurrency,
  getChallengeFee,
  type AccountSize,
  type ChallengeType,
  type DrawdownMode,
} from '@/lib/challenges'

const SIZE_OPTIONS = ACCOUNT_SIZES.map((size) => ({ value: size, label: formatCompact(size).replace('K', 'k') }))

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
        <dt className="text-sm text-muted-foreground">{label}</dt>
        <Tooltip>
          <TooltipTrigger
            className="rounded text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label={`About ${label}`}
          >
            <Info className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>{hint}</TooltipContent>
        </Tooltip>
      </div>
      <dd className="text-right">
        <span className={muted ? 'font-mono text-sm text-muted-foreground' : 'font-mono text-base font-semibold tabular-nums text-foreground'}>
          {value}
        </span>
        {subValue && <span className="block font-mono text-xs tabular-nums text-muted-foreground">{subValue}</span>}
      </dd>
    </div>
  )
}

export function ChallengeCalculator() {
  const [size, setSize] = useState<AccountSize>(100_000)
  const [type, setType] = useState<ChallengeType>('two-step')
  const [drawdownMode, setDrawdownMode] = useState<DrawdownMode>('trailing')

  const rules = CHALLENGES[type]
  const fee = getChallengeFee(type, size, drawdownMode)
  const phase1Amount = (size * rules.phase1Target) / 100
  const phase2Amount = rules.phase2Target ? (size * rules.phase2Target) / 100 : null
  const dailyAmount = (size * rules.dailyDrawdown) / 100
  const overallAmount = (size * rules.overallDrawdown) / 100
  const projectedPayout = phase1Amount * 0.9

  return (
    <section id="challenges" aria-labelledby="challenges-heading" className="border-b border-border py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          id="challenges-heading"
          eyebrow="Challenge matrix"
          title="Pick your capital. Pick your path."
          description="Configure your evaluation and see every rule upfront. Your fee is fully refunded with your first payout."
        />

        <div className="mt-14 overflow-hidden rounded-2xl border border-border bg-card">
          <div className="grid gap-6 border-b border-border p-5 sm:p-6 lg:grid-cols-[1fr_auto]">
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Account size
              </p>
              <SegmentedControl
                label="Account size"
                options={SIZE_OPTIONS}
                value={size}
                onChange={setSize}
                className="grid grid-cols-3 sm:flex"
              />
            </div>
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Evaluation type</p>
              <SegmentedControl label="Evaluation type" options={TYPE_OPTIONS} value={type} onChange={setType} />
            </div>
          </div>

          <div className="grid lg:grid-cols-[1fr_380px]">
            <div className="p-5 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-lg font-semibold text-foreground">
                  {formatCurrency(size)} · {rules.label}
                </h3>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                  <span className="size-1.5 rounded-full bg-primary" />
                  Instant credentials
                </span>
              </div>

              <dl className="mt-4 divide-y divide-border">
                <MetricRow
                  label="Phase 1 profit target"
                  hint="Reach this closed profit on your account balance to pass Phase 1."
                  value={`${rules.phase1Target}%`}
                  subValue={formatCurrency(phase1Amount)}
                />
                <MetricRow
                  label="Phase 2 profit target"
                  hint="The verification phase. Not required for the 1-Step Challenge."
                  value={rules.phase2Target ? `${rules.phase2Target}%` : 'N/A'}
                  subValue={phase2Amount ? formatCurrency(phase2Amount) : 'Single-phase evaluation'}
                  muted={!rules.phase2Target}
                />
                <MetricRow
                  label="Max daily drawdown"
                  hint="Measured from the higher of balance or equity at 00:00 server time (CE(S)T)."
                  value={`${rules.dailyDrawdown}%`}
                  subValue={formatCurrency(dailyAmount)}
                />
                <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-1.5">
                    <dt className="text-sm text-muted-foreground">Max overall drawdown</dt>
                    <Tooltip>
                      <TooltipTrigger
                        className="rounded text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        aria-label="About max overall drawdown"
                      >
                        <Info className="size-3.5" />
                      </TooltipTrigger>
                      <TooltipContent>
                        Trailing follows your equity high-water mark until it locks at the starting balance. Static stays
                        fixed below your initial balance.
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
                      <span className="font-mono text-base font-semibold tabular-nums text-foreground">
                        {rules.overallDrawdown}%
                      </span>
                      <span className="block font-mono text-xs tabular-nums text-muted-foreground">
                        {formatCurrency(overallAmount)}
                      </span>
                    </span>
                  </dd>
                </div>
                <div className="py-4">
                  <dt className="text-sm text-muted-foreground">Leverage</dt>
                  <dd className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {LEVERAGE.map((item) => (
                      <div key={item.market} className="rounded-md border border-border bg-background px-3 py-2">
                        <p className="text-xs text-muted-foreground">{item.market}</p>
                        <p className="font-mono text-sm font-semibold text-foreground">{item.value}</p>
                      </div>
                    ))}
                  </dd>
                </div>
              </dl>
            </div>

            <aside
              aria-label="Checkout summary"
              className="flex flex-col border-t border-border bg-background/60 p-5 sm:p-6 lg:border-t-0 lg:border-l"
            >
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">One-time refundable fee</p>
              <p className="mt-2 flex items-baseline gap-2" aria-live="polite">
                <span className="font-mono text-5xl font-semibold tracking-tight tabular-nums text-foreground">
                  {formatCurrency(fee)}
                </span>
                <span className="text-sm text-muted-foreground">USD</span>
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {drawdownMode === 'static' ? 'Includes static drawdown upgrade.' : 'Trailing drawdown — best value.'}
              </p>

              <div className="mt-6 rounded-lg border border-border bg-card p-4">
                <p className="text-xs text-muted-foreground">Projected first payout at Phase 1 target</p>
                <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-primary">
                  {formatCurrency(projectedPayout)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">Based on a 90% profit split</p>
              </div>

              <ul className="mt-6 flex flex-col gap-3 text-sm">
                <li className="flex items-center gap-2.5 text-foreground">
                  <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
                  Up to 90% profit split
                </li>
                <li className="flex items-center gap-2.5 text-foreground">
                  <RotateCcw className="size-4 text-primary" aria-hidden="true" />
                  Fee refunded with first payout
                </li>
                <li className="flex items-center gap-2.5 text-foreground">
                  <Zap className="size-4 text-primary" aria-hidden="true" />
                  Min. {rules.minTradingDays} trading days · no maximum
                </li>
              </ul>

              <a
                href="#dashboard"
                className="group mt-8 inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-linear-to-r from-primary to-highlight px-6 text-sm font-semibold text-primary-foreground shadow-[0_0_40px_-12px] shadow-primary transition-opacity hover:opacity-90 lg:mt-auto"
              >
                Start Challenge — {formatCurrency(fee)}
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </a>
              <p className="mt-3 text-center text-xs text-muted-foreground">Card, Apple Pay & crypto accepted</p>
            </aside>
          </div>
        </div>
      </div>
    </section>
  )
}
