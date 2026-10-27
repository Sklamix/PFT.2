import { ChevronDown, CircleCheck, CircleDashed, CircleX } from 'lucide-react'
import { formatUsd, getMetrics, severityFor, type Severity, type TradingAccount } from '@/lib/dashboard-data'
import { cn } from '@/lib/utils'
import { SEVERITY_BG, SEVERITY_CHIP } from './status-dot'

type Objective = {
  name: string
  status: string
  severity: Severity
  done: boolean
  value: string
  ratio: number
  detail: string
}

function buildObjectives(account: TradingAccount): Objective[] {
  const metrics = getMetrics(account)
  const dailyRatio = account.worstDailyLossPct / account.dailyLossPct
  const overallRatio = account.worstOverallLossPct / account.maxLossPct
  const daysMet = account.tradingDays >= account.minTradingDays

  const objectives: Objective[] = [
    {
      name: 'Min Trading Days',
      status: daysMet ? 'Passed' : 'Pending',
      severity: daysMet ? 'safe' : 'caution',
      done: daysMet,
      value: `${Math.min(account.tradingDays, account.minTradingDays)}/${account.minTradingDays} Days`,
      ratio: Math.min(1, account.tradingDays / account.minTradingDays),
      detail: 'A trading day counts when at least one position is opened between two 00:00 CE(S)T resets.',
    },
    {
      name: 'Max Daily Loss',
      status: dailyRatio >= 1 ? 'Breached' : 'Safe',
      severity: dailyRatio >= 1 ? 'danger' : severityFor(dailyRatio),
      done: dailyRatio < 1,
      value: `${account.worstDailyLossPct.toFixed(1)}% / Limit ${account.dailyLossPct.toFixed(1)}%`,
      ratio: Math.min(1, dailyRatio),
      detail: `Worst recorded intraday loss. Equity may not fall more than ${formatUsd(metrics.dailyLimit, { compact: true })} below the day's starting equity.`,
    },
    {
      name: 'Max Overall Loss',
      status: overallRatio >= 1 ? 'Breached' : 'Safe',
      severity: overallRatio >= 1 ? 'danger' : severityFor(overallRatio),
      done: overallRatio < 1,
      value: `${account.worstOverallLossPct.toFixed(1)}% / Limit ${account.maxLossPct.toFixed(1)}%`,
      ratio: Math.min(1, overallRatio),
      detail: `Deepest drawdown from the initial balance. Equity must stay above ${formatUsd(metrics.maxFloor, { compact: true })} at all times.`,
    },
  ]

  if (metrics.target !== null) {
    objectives.push({
      name: 'Profit Target',
      status: metrics.targetPassed ? 'Achieved' : 'In progress',
      severity: metrics.targetPassed ? 'safe' : 'caution',
      done: metrics.targetPassed,
      value: `${formatUsd(Math.max(0, metrics.profit), { compact: true })} / ${formatUsd(metrics.target, { compact: true })} Required`,
      ratio: metrics.targetProgress ?? 0,
      detail: `Reach ${account.targetPct}% closed profit on the initial balance without breaching a loss rule.`,
    })
  } else {
    objectives.push({
      name: 'Payout Threshold',
      status: metrics.profit >= account.size * 0.02 ? 'Achieved' : 'In progress',
      severity: metrics.profit >= account.size * 0.02 ? 'safe' : 'caution',
      done: metrics.profit >= account.size * 0.02,
      value: `${formatUsd(Math.max(0, metrics.profit), { compact: true })} / ${formatUsd(account.size * 0.02, { compact: true })} Min`,
      ratio: Math.min(1, Math.max(0, metrics.profit) / (account.size * 0.02)),
      detail: 'Funded accounts need at least 2% profit in the cycle to request a disbursement.',
    })
  }

  return objectives
}

const BAR_TONE: Record<string, (objective: Objective) => string> = {
  progress: (objective) => (objective.done ? 'bg-primary' : 'bg-warning'),
  risk: (objective) => SEVERITY_BG[objective.severity],
}

export function ObjectivesChecklist({ account }: { account: TradingAccount }) {
  const objectives = buildObjectives(account)
  const completed = objectives.filter((objective) => objective.done).length

  return (
    <section aria-labelledby="objectives-title" className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
      <header className="flex items-center justify-between">
        <div>
          <h2 id="objectives-title" className="text-base font-semibold text-foreground">Trading Objectives</h2>
          <p className="text-sm text-muted-foreground">Prop rule tracker · live</p>
        </div>
        <span className="font-mono text-sm text-muted-foreground">
          <span className="text-foreground">{completed}</span>/{objectives.length}
        </span>
      </header>
      <ul className="flex flex-col gap-2">
        {objectives.map((objective) => {
          const isRisk = objective.name.startsWith('Max')
          const Icon = objective.severity === 'danger' ? CircleX : objective.done ? CircleCheck : CircleDashed
          return (
            <li key={objective.name}>
              <details className="group rounded-lg border border-border bg-background/60 open:border-muted-foreground/30">
                <summary className="flex cursor-pointer list-none flex-col gap-2.5 p-3 [&::-webkit-details-marker]:hidden">
                  <div className="flex items-center gap-2.5">
                    <Icon
                      className={cn('size-4 shrink-0', objective.severity === 'danger' ? 'text-danger' : objective.done ? 'text-primary' : 'text-warning')}
                      aria-hidden="true"
                    />
                    <span className="flex-1 text-sm font-medium text-foreground">{objective.name}</span>
                    <span className={cn('rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider', SEVERITY_CHIP[objective.severity])}>
                      {objective.status}
                    </span>
                    <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
                  </div>
                  <div className="flex items-center gap-3 pl-6.5">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                      <div
                        className={cn('h-full rounded-full', BAR_TONE[isRisk ? 'risk' : 'progress'](objective))}
                        style={{ width: `${Math.max(3, objective.ratio * 100)}%` }}
                      />
                    </div>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{objective.value}</span>
                  </div>
                </summary>
                <p className="border-t border-border px-3 py-2.5 pl-9.5 text-xs leading-relaxed text-muted-foreground">{objective.detail}</p>
              </details>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
