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
    <section
      id="dashboard"
      aria-labelledby="dashboard-heading"
      data-home-reveal
      className="relative overflow-hidden border-b border-white/5 py-24 sm:py-32"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_20%,rgba(6,182,212,0.14),transparent_52%)]" />
      <div className="pointer-events-none absolute bottom-0 left-1/2 h-96 w-[900px] -translate-x-1/2 rounded-full bg-primary/10 blur-[120px]" />
      <div className="pointer-events-none absolute -right-40 top-24 size-[32rem] rounded-full border border-highlight/10" />
      <div className="pointer-events-none absolute inset-0 cosmic-stars opacity-50" />
      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 2xl:max-w-[1600px]">
        <SectionHeading
          id="dashboard-heading"
          eyebrow="Trader portal"
          title="Every metric that matters. In real time."
          description="Track equity, risk buffers and payout windows from a single, distraction-free command center."
        />

        <div className="home-card cosmic-card mt-14 rounded-[2rem] shadow-[0_60px_160px_-70px_rgba(59,130,246,0.75)]">
          <div className="flex items-center justify-between border-b border-white/10 bg-black/25 px-4 py-3.5">
            <div className="flex items-center gap-2" aria-hidden="true">
              <span className="size-2.5 rounded-full bg-danger/80 shadow-[0_0_10px_rgba(244,63,94,0.5)]" />
              <span className="size-2.5 rounded-full bg-warning/80 shadow-[0_0_10px_rgba(245,158,11,0.5)]" />
              <span className="size-2.5 rounded-full bg-highlight/80 shadow-[0_0_10px_rgba(6,182,212,0.5)]" />
            </div>
            <p className="font-mono text-[10px] text-slate-500 sm:text-xs">portal.pft.trade/accounts/PFT-200481</p>
            <Bell className="size-4 text-slate-500" aria-hidden="true" />
          </div>

          <div className="grid md:grid-cols-[210px_1fr]">
            <nav aria-label="Portal preview" className="hidden border-r border-white/[0.07] bg-black/15 p-3 md:block">
              <ul className="flex flex-col gap-1">
                {SIDEBAR.map(({ icon: Icon, label, active }) => (
                  <li key={label}>
                    <span
                      className={
                        active
                          ? 'flex items-center gap-2.5 rounded-xl border border-primary/20 bg-primary/10 px-3 py-2 text-sm font-medium text-white shadow-[inset_0_0_20px_rgba(59,130,246,0.08)]'
                          : 'flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-slate-500 transition-colors hover:bg-white/[0.04] hover:text-slate-200'
                      }
                    >
                      <Icon className={active ? 'size-4 text-primary' : 'size-4'} aria-hidden="true" />
                      {label}
                    </span>
                  </li>
                ))}
              </ul>
            </nav>

            <div className="flex flex-col gap-4 p-4 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs text-slate-500">$100,000 · 2-Step Evaluation · Funded</p>
                  <p className="mt-1 text-lg font-semibold text-white">Account PFT-200481</p>
                </div>
                <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                  <span className="relative flex size-2">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60 motion-reduce:hidden" />
                    <span className="relative inline-flex size-2 rounded-full bg-primary shadow-[0_0_8px_1px_rgba(59,130,246,0.6)]" />
                  </span>
                  Active — Funded
                </span>
              </div>

              <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                {stats.map((stat) => (
                  <div key={stat.label} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                    <dt className="text-[10px] uppercase tracking-[0.14em] text-slate-500">{stat.label}</dt>
                    <dd className={stat.positive ? 'mt-1.5 font-mono text-lg font-semibold tabular-nums text-primary' : 'mt-1.5 font-mono text-lg font-semibold tabular-nums text-white'}>
                      {stat.value}
                    </dd>
                  </div>
                ))}
              </dl>

              <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
                <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-white">Equity curve</p>
                    <p className="flex items-center gap-1 font-mono text-xs text-primary">
                      <TrendingUp className="size-3.5" aria-hidden="true" />+{profitPct.toFixed(2)}%
                    </p>
                  </div>
                  <div className="mt-4">
                    <EquityChart />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-slate-500">Starting balance: {formatCurrency(EQUITY_START)}</p>
                    <p className="text-xs text-slate-500">
                      Your 90% share:{' '}
                      <span className="font-mono font-semibold text-primary">{formatCurrency(profit * 0.9)}</span>
                    </p>
                  </div>
                </div>

                <div className="flex flex-col gap-4">
                  <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-white">Daily loss buffer</p>
                      <p className="font-mono text-[10px] text-slate-500">5% limit</p>
                    </div>
                    <p className="mt-3 font-mono text-2xl font-semibold tabular-nums text-white">
                      {formatCurrency(bufferRemaining)}
                    </p>
                    <div
                      className="mt-3 h-2 overflow-hidden rounded-full bg-white/10"
                      role="progressbar"
                      aria-valuenow={Math.round(bufferPct)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label="Daily loss buffer remaining"
                    >
                      <div
                        className="h-full rounded-full bg-linear-to-r from-primary to-highlight shadow-[0_0_12px_rgba(59,130,246,0.6)]"
                        style={{ width: `${bufferPct}%` }}
                      />
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      {formatCurrency(DAILY_USED)} used of {formatCurrency(DAILY_LIMIT)} today
                    </p>
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                    <p className="text-sm font-medium text-white">Next payout window</p>
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
