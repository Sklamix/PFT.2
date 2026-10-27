'use client'

import type { ReactNode } from 'react'
import { Activity, Gauge, ShieldAlert, Target } from 'lucide-react'
import { useNow } from '@/hooks/use-now'
import {
  formatClock,
  formatPct,
  formatUsd,
  getMetrics,
  nextUtcMidnight,
  severityFor,
  type Severity,
  type TradingAccount,
} from '@/lib/dashboard-data'
import { cn } from '@/lib/utils'
import { SEVERITY_BG, SEVERITY_CHIP, SEVERITY_TEXT } from './status-dot'

export function MetricCards({ account }: { account: TradingAccount }) {
  const metrics = getMetrics(account)
  return (
    <section aria-label="Guardrail metrics" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <BalanceCard account={account} metrics={metrics} />
      <DailyDrawdownCard account={account} metrics={metrics} />
      <MaxDrawdownCard account={account} metrics={metrics} />
      <TargetCard account={account} metrics={metrics} />
    </section>
  )
}

type Metrics = ReturnType<typeof getMetrics>
type CardProps = { account: TradingAccount; metrics: Metrics }

function MetricCard({ title, icon, badge, children }: { title: string; icon: ReactNode; badge?: ReactNode; children: ReactNode }) {
  return (
    <article className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
      <header className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          {icon}
          {title}
        </h3>
        {badge}
      </header>
      {children}
    </article>
  )
}

function Chip({ severity, children }: { severity: Severity; children: ReactNode }) {
  return (
    <span className={cn('rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider', SEVERITY_CHIP[severity])}>
      {children}
    </span>
  )
}

function Meter({ ratio, label }: { ratio: number; label: string }) {
  const severity = severityFor(ratio)
  const percent = Math.round(ratio * 100)
  return (
    <div>
      <div
        className="relative h-2 overflow-hidden rounded-full bg-secondary"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-700', SEVERITY_BG[severity])}
          style={{ width: `${Math.max(2, percent)}%` }}
        />
        <span className="absolute inset-y-0 left-1/2 w-px bg-background" aria-hidden="true" />
        <span className="absolute inset-y-0 left-[80%] w-px bg-background" aria-hidden="true" />
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[10px] text-muted-foreground">
        <span className={SEVERITY_TEXT[severity]}>{percent}% of limit used</span>
        <span>
          <span className="text-primary">0</span> · <span className="text-warning">50</span> · <span className="text-danger">80</span>
        </span>
      </div>
    </div>
  )
}

function BalanceCard({ account, metrics }: CardProps) {
  const positive = metrics.profit >= 0
  const rangeMin = -account.maxLossPct
  const rangeMax = account.targetPct ?? 10
  const position = Math.min(1, Math.max(0, (metrics.profitPct - rangeMin) / (rangeMax - rangeMin)))
  const zero = (0 - rangeMin) / (rangeMax - rangeMin)

  return (
    <MetricCard
      title="Simulated Equity"
      icon={<Activity className="size-4 text-highlight" aria-hidden="true" />}
      badge={<Chip severity={positive ? 'safe' : 'danger'}>{formatPct(metrics.profitPct, true)}</Chip>}
    >
      <div>
        <p className="font-mono text-3xl font-semibold tracking-tight text-foreground tabular-nums">{formatUsd(account.equity)}</p>
        <p className={cn('mt-1 font-mono text-xs', positive ? 'text-primary' : 'text-danger')}>
          {formatUsd(metrics.profit, { signed: true })} {metrics.floating === 0 ? 'locked' : 'incl. floating'}
        </p>
      </div>
      <div>
        <div className="relative h-2 rounded-full bg-linear-to-r from-danger/50 via-secondary to-primary/60" aria-hidden="true">
          <span className="absolute inset-y-0 w-px bg-muted-foreground" style={{ left: `${zero * 100}%` }} />
          <span
            className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-foreground shadow-[0_0_10px_var(--highlight)]"
            style={{ left: `${position * 100}%` }}
          />
        </div>
        <div className="mt-1.5 flex justify-between font-mono text-[10px] text-muted-foreground">
          <span>-{account.maxLossPct}%</span>
          <span>0%</span>
          <span>+{rangeMax}%</span>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-2 border-t border-border pt-3 font-mono text-xs">
        <div>
          <dt className="text-muted-foreground">Balance</dt>
          <dd className="text-foreground tabular-nums">{formatUsd(account.balance)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Floating P/L</dt>
          <dd className={cn('tabular-nums', metrics.floating >= 0 ? 'text-foreground' : 'text-danger')}>{formatUsd(metrics.floating, { signed: true })}</dd>
        </div>
      </dl>
    </MetricCard>
  )
}

function DailyDrawdownCard({ account, metrics }: CardProps) {
  const now = useNow()
  const severity = severityFor(metrics.dailyRatio)
  return (
    <MetricCard
      title="Daily Drawdown"
      icon={<Gauge className="size-4 text-highlight" aria-hidden="true" />}
      badge={<Chip severity={severity}>{severity === 'safe' ? 'Safe' : severity === 'caution' ? 'Caution' : 'Critical'}</Chip>}
    >
      <div>
        <p className={cn('font-mono text-3xl font-semibold tracking-tight tabular-nums', SEVERITY_TEXT[severity])}>{formatUsd(metrics.dailyBuffer)}</p>
        <p className="mt-1 font-mono text-xs text-muted-foreground">buffer remaining today</p>
      </div>
      <Meter ratio={metrics.dailyRatio} label="Daily loss limit used" />
      <dl className="grid grid-cols-2 gap-2 border-t border-border pt-3 font-mono text-xs">
        <div>
          <dt className="text-muted-foreground">Daily floor</dt>
          <dd className="text-foreground tabular-nums">{formatUsd(metrics.dailyFloor, { compact: true })}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Resets 00:00 CE(S)T</dt>
          <dd className="text-foreground tabular-nums">{now === null ? '--:--:--' : formatClock(nextUtcMidnight(now) - now)}</dd>
        </div>
      </dl>
      <p className="sr-only">Daily loss limit is {account.dailyLossPct}% of the starting balance.</p>
    </MetricCard>
  )
}

function MaxDrawdownCard({ account, metrics }: CardProps) {
  const severity = severityFor(metrics.maxRatio)
  const breached = account.equity <= metrics.maxFloor
  return (
    <MetricCard
      title="Max Overall Drawdown"
      icon={<ShieldAlert className="size-4 text-highlight" aria-hidden="true" />}
      badge={<Chip severity={breached ? 'danger' : severity}>{breached ? 'Breached' : severity === 'safe' ? 'Safe' : 'Caution'}</Chip>}
    >
      <div>
        <p className={cn('font-mono text-3xl font-semibold tracking-tight tabular-nums', SEVERITY_TEXT[breached ? 'danger' : severity])}>
          {formatUsd(metrics.maxBuffer)}
        </p>
        <p className="mt-1 font-mono text-xs text-muted-foreground">distance from breach</p>
      </div>
      <Meter ratio={metrics.maxRatio} label="Max overall loss used" />
      <dl className="grid grid-cols-2 gap-2 border-t border-border pt-3 font-mono text-xs">
        <div>
          <dt className="text-muted-foreground">Absolute floor</dt>
          <dd className="text-foreground tabular-nums">{formatUsd(metrics.maxFloor, { compact: true })}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Limit</dt>
          <dd className="text-foreground tabular-nums">{account.maxLossPct}% static</dd>
        </div>
      </dl>
    </MetricCard>
  )
}

function TargetCard({ account, metrics }: CardProps) {
  const isFunded = metrics.target === null
  const progress = isFunded ? Math.min(1, Math.max(0, metrics.profit) / (account.size * 0.02)) : (metrics.targetProgress ?? 0)
  const passed = isFunded ? progress >= 1 : metrics.targetPassed
  const radius = 34
  const circumference = 2 * Math.PI * radius

  return (
    <MetricCard
      title={isFunded ? 'Payout Accrual' : 'Profit Target'}
      icon={<Target className="size-4 text-highlight" aria-hidden="true" />}
      badge={passed ? <Chip severity="safe">{isFunded ? 'Eligible' : 'Target Passed'}</Chip> : <Chip severity="caution">In progress</Chip>}
    >
      <div className="flex items-center gap-4">
        <svg viewBox="0 0 80 80" className="size-20 shrink-0 -rotate-90" role="img" aria-label={`${Math.round(progress * 100)}% complete`}>
          <defs>
            <linearGradient id="target-ring" x1="0" x2="1" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--highlight)" />
              <stop offset="100%" stopColor="var(--primary)" />
            </linearGradient>
          </defs>
          <circle cx="40" cy="40" r={radius} fill="none" stroke="var(--secondary)" strokeWidth="7" />
          <circle
            cx="40"
            cy="40"
            r={radius}
            fill="none"
            stroke="url(#target-ring)"
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - progress)}
            className="transition-[stroke-dashoffset] duration-700"
          />
          <text x="40" y="40" dy="0.35em" textAnchor="middle" className="rotate-90 fill-foreground font-mono text-[15px] font-semibold" style={{ transformOrigin: '40px 40px' }}>
            {Math.round(progress * 100)}%
          </text>
        </svg>
        <div className="min-w-0">
          <p className="font-mono text-2xl font-semibold tracking-tight text-foreground tabular-nums">{formatUsd(Math.max(0, metrics.profit), { compact: true })}</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {isFunded ? `${account.profitSplit}% share: ${formatUsd(metrics.traderShare, { compact: true })}` : `of ${formatUsd(metrics.target ?? 0, { compact: true })} required (${account.targetPct}%)`}
          </p>
        </div>
      </div>
      <p className="border-t border-border pt-3 font-mono text-xs text-muted-foreground">
        {isFunded
          ? 'Minimum 2% profit required for disbursement.'
          : passed
            ? `Phase complete once ${account.minTradingDays} trading days are met.`
            : `${formatUsd(Math.max(0, (metrics.target ?? 0) - metrics.profit), { compact: true })} left to target.`}
      </p>
    </MetricCard>
  )
}
