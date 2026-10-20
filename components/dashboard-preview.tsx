import { LayoutDashboard, LineChart, Wallet, ShieldCheck, Settings, Bell, TrendingUp } from 'lucide-react'
import { EquityChart, EQUITY_LATEST, EQUITY_START } from '@/components/equity-chart'
import { PayoutCountdown } from '@/components/payout-countdown'
import { SectionHeading } from '@/components/section-heading'
import { formatCurrency } from '@/lib/challenges'

const SIDEBAR = [
  { icon: LayoutDashboard, label: 'Overview', active: true },
  { icon: LineChart, label: 'Analytics' },
  { icon: Wallet, label: 'Payouts' },
  { icon: ShieldCheck, label: 'Certificates' },
  { icon: Settings, label: 'Settings' },
]

const DAILY_LIMIT = 5_000
const DAILY_USED = 1_240

export function DashboardPreview() {
  const profit = EQUITY_LATEST - EQUITY_START
  const profitPct = (profit / EQUITY_START) * 100
  const bufferRemaining = DAILY_LIMIT - DAILY_USED
  const bufferPct = (bufferRemaining / DAILY_LIMIT) * 100

  const stats = [
    { label: 'Equity', value: formatCurrency(EQUITY_LATEST) },
    { label: 'Total P&L', value: `+${formatCurrency(profit)}`, positive: true },
    { label: 'Win rate', value: '64.2%' },
    { label: 'Trading days', value: '11 / 4 min' },
  ]

  return (
    <section id="dashboard" aria-labelledby="dashboard-heading" data-home-reveal className="relative overflow-hidden border-b border-border py-20 sm:py-28">
      <div className="pointer-events-none absolute bottom-0 left-1/2 h-80 w-[800px] -translate-x-1/2 rounded-full bg-highlight/10 blur-3xl" />
      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          id="dashboard-heading"
          eyebrow="Trader portal"
          title="Every metric that matters. In real time."
          description="Track equity, risk buffers and payout windows from a single, distraction-free command center."
        />

        <div className="home-card mt-14 overflow-hidden rounded-2xl border border-border bg-card shadow-2xl shadow-black/40">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2" aria-hidden="true">
              <span className="size-2.5 rounded-full bg-border" />
              <span className="size-2.5 rounded-full bg-border" />
              <span className="size-2.5 rounded-full bg-border" />
            </div>
            <p className="font-mono text-xs text-muted-foreground">portal.pft.trade/accounts/PFT-200481</p>
            <Bell className="size-4 text-muted-foreground" aria-hidden="true" />
          </div>

          <div className="grid md:grid-cols-[200px_1fr]">
            <nav aria-label="Portal preview" className="hidden border-r border-border p-3 md:block">
              <ul className="flex flex-col gap-1">
                {SIDEBAR.map(({ icon: Icon, label, active }) => (
                  <li key={label}>
                    <span
                      className={
                        active
                          ? 'flex items-center gap-2.5 rounded-md bg-accent px-3 py-2 text-sm font-medium text-foreground'
                          : 'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground'
                      }
                    >
                      <Icon className="size-4" aria-hidden="true" />
                      {label}
                    </span>
                  </li>
                ))}
              </ul>
            </nav>

            <div className="flex flex-col gap-4 p-4 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs text-muted-foreground">$100,000 · 2-Step Evaluation · Funded</p>
                  <p className="mt-1 text-lg font-semibold text-foreground">Account PFT-200481</p>
                </div>
                <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                  <span className="relative flex size-2">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60 motion-reduce:hidden" />
                    <span className="relative inline-flex size-2 rounded-full bg-primary" />
                  </span>
                  Active — Funded
                </span>
              </div>

              <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border lg:grid-cols-4">
                {stats.map((stat) => (
                  <div key={stat.label} className="bg-background p-4">
                    <dt className="text-xs text-muted-foreground">{stat.label}</dt>
                    <dd className={stat.positive ? 'mt-1 font-mono text-lg font-semibold tabular-nums text-primary' : 'mt-1 font-mono text-lg font-semibold tabular-nums text-foreground'}>
                      {stat.value}
                    </dd>
                  </div>
                ))}
              </dl>

              <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
                <div className="rounded-lg border border-border bg-background p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-foreground">Equity curve</p>
                    <p className="flex items-center gap-1 font-mono text-xs text-primary">
                      <TrendingUp className="size-3.5" aria-hidden="true" />+{profitPct.toFixed(2)}%
                    </p>
                  </div>
                  <div className="mt-4">
                    <EquityChart />
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">Starting balance: {formatCurrency(EQUITY_START)}</p>
                    <p className="text-xs text-muted-foreground">
                      Your 90% share:{' '}
                      <span className="font-mono font-semibold text-primary">{formatCurrency(profit * 0.9)}</span>
                    </p>
                  </div>
                </div>

                <div className="flex flex-col gap-4">
                  <div className="rounded-lg border border-border bg-background p-4">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-foreground">Daily loss buffer</p>
                      <p className="font-mono text-xs text-muted-foreground">5% limit</p>
                    </div>
                    <p className="mt-3 font-mono text-2xl font-semibold tabular-nums text-foreground">
                      {formatCurrency(bufferRemaining)}
                    </p>
                    <div
                      className="mt-3 h-2 overflow-hidden rounded-full bg-border"
                      role="progressbar"
                      aria-valuenow={Math.round(bufferPct)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label="Daily loss buffer remaining"
                    >
                      <div className="h-full rounded-full bg-primary" style={{ width: `${bufferPct}%` }} />
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {formatCurrency(DAILY_USED)} used of {formatCurrency(DAILY_LIMIT)} today
                    </p>
                  </div>

                  <div className="rounded-lg border border-border bg-background p-4">
                    <p className="text-sm font-medium text-foreground">Next payout window</p>
                    <div className="mt-3">
                      <PayoutCountdown />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
