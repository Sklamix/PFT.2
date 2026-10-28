'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowUpRight, CandlestickChart, Wallet } from 'lucide-react'
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useOverview, type OverviewAccount } from '@/lib/stores/useOverview'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ChevronDown } from 'lucide-react'
import { SpaceBackground } from './space-background'

const BG = '#080C14'
const SLATE_LABEL = '#94A3B8'
const GREEN = '#22C55E'
const RED = '#EF4444'

const usd = (n: number) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const signedUsd = (n: number) =>
  `${n >= 0 ? '+' : '-'}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function phaseLabel(account: OverviewAccount): string {
  if (account.isBreached) return 'BREACHED'
  if (account.phase === 'FUNDED') return 'FUNDED'
  if (account.phase === 'PHASE_2') return 'PHASE 2'
  return 'PHASE 1'
}

function Card({ title, children, className = '' }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-slate-800/80 bg-[#0B0F19]/80 p-5 backdrop-blur-md ${className}`}>
      {title ? (
        <h2 className="mb-4 text-[11px] font-medium uppercase tracking-[0.18em] text-[#94A3B8]">{title}</h2>
      ) : null}
      {children}
    </section>
  )
}

function Bar({ value, danger = false }: { value: number; danger?: boolean }) {
  const width = Math.max(0, Math.min(100, Math.round(value * 100)))
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-slate-800">
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${width}%`, backgroundColor: danger ? RED : SLATE_LABEL }}
      />
    </div>
  )
}

function Kpi({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-800/80 bg-[#0B0F19]/80 p-5 backdrop-blur-md">
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#94A3B8]">{label}</p>
      <div className="mt-2 font-mono text-2xl font-semibold tabular-nums tracking-tight text-slate-100">{children}</div>
    </div>
  )
}

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: number }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-md border border-slate-800 bg-[#0C1220] px-3 py-2 text-xs">
      <p className="text-[#94A3B8]">
        {new Date(Number(label)).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
      </p>
      <p className="font-mono tabular-nums text-slate-100">{usd(Number(payload[0].value))}</p>
    </div>
  )
}

export function OverviewCockpit() {
  const data = useOverview((state) => state.data)
  const loadState = useOverview((state) => state.loadState)
  const error = useOverview((state) => state.error)
  const selectedId = useOverview((state) => state.selectedAccountId)
  const load = useOverview((state) => state.load)
  const select = useOverview((state) => state.select)

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(timer)
  }, [load])

  const accounts = data?.accounts ?? []
  const selected = accounts.find((account) => account.id === selectedId) ?? accounts[0]
  const curve = selected && data?.curves ? (data.curves[selected.id] ?? []) : []

  if (loadState === 'error') {
    return (
      <div className="min-h-dvh bg-transparent px-6 py-16 text-center text-sm text-[#94A3B8]">
        {error ?? 'Unable to load overview.'}
      </div>
    )
  }

  if (!selected && loadState === 'ready') {
    return (
      <div className="min-h-dvh bg-transparent px-6 py-16 text-center">
        <p className="text-sm text-[#94A3B8]">No trading accounts yet.</p>
        <Link href="/dashboard/terminal" className="mt-3 inline-flex items-center gap-1 text-sm text-sky-300 hover:text-sky-200">
          Open Terminal <ArrowUpRight className="size-4" />
        </Link>
      </div>
    )
  }

  const pnlColor = (n: number) => (n >= 0 ? GREEN : RED)

  return (
    <div className="relative min-h-dvh">
      <SpaceBackground />
      <div className="relative z-10 mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Header */}
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-slate-100">Overview</h1>
              <p className="mt-0.5 text-sm text-[#94A3B8]">Equity, PnL and drawdown guardrails at a glance.</p>
            </div>
            {selected && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  className="flex h-9 items-center gap-2 rounded-md border border-slate-800 bg-[#0B0F19]/80 px-3 font-mono text-sm text-slate-200 outline-none transition-colors hover:border-slate-600 focus-visible:border-slate-600 aria-expanded:border-slate-600"
                  aria-label={`Active account ${selected.displayId}. Change account`}
                >
                  <span className="inline-block size-1.5 rounded-full" style={{ backgroundColor: selected.isBreached ? RED : GREEN }} aria-hidden="true" />
                  <span className="tabular-nums">{selected.displayId}</span>
                  <span className="text-xs text-[#94A3B8]">({phaseLabel(selected)})</span>
                  <ChevronDown className="size-3.5 text-[#94A3B8]" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-72 border-slate-800 bg-[#0B0F19]">
                  <DropdownMenuRadioGroup value={selected.id} onValueChange={(value) => select(String(value))}>
                    {accounts.map((account) => (
                      <DropdownMenuRadioItem key={account.id} value={account.id} className="gap-0 py-2">
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <span className="flex items-center gap-2 font-mono text-xs font-semibold text-slate-100">
                            <span
                              className="inline-block size-1.5 rounded-full"
                              style={{ backgroundColor: account.isBreached ? RED : GREEN }}
                              aria-hidden="true"
                            />
                            {account.displayId}
                          </span>
                          <span className="flex items-center gap-2 text-[11px] text-[#94A3B8]">
                            {phaseLabel(account)} · <span className="font-mono tabular-nums">{usd(account.equity)}</span>
                          </span>
                        </div>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Link
              href={selected ? `/dashboard/terminal?account=${encodeURIComponent(selected.id)}` : '/dashboard/terminal'}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-800 px-3 text-sm text-slate-300 transition-colors hover:border-slate-600 hover:text-slate-100"
            >
              <CandlestickChart className="size-4" /> Open Terminal
            </Link>
          </div>
        </header>

        {/* KPI row */}
        <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Kpi label="Equity">{selected ? usd(selected.equity) : '—'}</Kpi>
          <Kpi label="Today's PnL">
            <span style={{ color: selected ? pnlColor(selected.todayPnl) : SLATE_LABEL }}>
              {selected ? signedUsd(selected.todayPnl) : '—'}
            </span>
          </Kpi>
          <Kpi label="Total PnL">
            <span style={{ color: selected ? pnlColor(selected.totalPnl) : SLATE_LABEL }}>
              {selected ? signedUsd(selected.totalPnl) : '—'}
            </span>
          </Kpi>
          <Kpi label="Phase Status">
            <span style={{ color: selected?.isBreached ? RED : SLATE_LABEL }}>
              {selected ? phaseLabel(selected) : '—'}
            </span>
          </Kpi>
        </div>

        {/* Main grid */}
        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            {/* Equity curve */}
            <Card title="Equity Curve">
              {curve.length > 1 ? (
                <div className="h-[280px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={curve} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
                      <defs>
                        <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#94A3B8" stopOpacity={0.16} />
                          <stop offset="100%" stopColor="#94A3B8" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <XAxis dataKey="t" hide type="number" domain={['dataMin', 'dataMax']} />
                      <YAxis hide domain={['auto', 'auto']} />
                      <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#334155', strokeDasharray: '3 3' }} />
                      <Area
                        type="monotone"
                        dataKey="equity"
                        stroke="#CBD5E1"
                        strokeWidth={1.5}
                        fill="url(#equityFill)"
                        dot={false}
                        activeDot={{ r: 3, fill: '#CBD5E1', stroke: BG }}
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="text-sm text-[#94A3B8]">No closed trades yet — the curve starts once you place a trade.</p>
              )}
            </Card>

            {/* Active accounts */}
            <Card title="Active Accounts">
              {accounts.length === 0 ? (
                <p className="text-sm text-[#94A3B8]">No accounts yet.</p>
              ) : (
                <ul className="space-y-4">
                  {accounts.map((account) => (
                    <li key={account.id}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-sm text-slate-100">{account.displayId}</span>
                          <span
                            className="rounded border border-slate-800 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide"
                            style={{ color: account.isBreached ? RED : SLATE_LABEL }}
                          >
                            {phaseLabel(account)}
                          </span>
                        </div>
                        <span className="font-mono text-xs tabular-nums text-[#94A3B8]">
                          {usd(account.equity)} / ${(account.planSize / 1000).toFixed(0)}k
                        </span>
                      </div>

                      <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5">
                        <div>
                          <div className="mb-1 flex justify-between text-[11px] text-[#94A3B8]">
                            <span>Profit Target</span>
                            <span className="font-mono tabular-nums">
                              {account.profitProgress != null
                                ? `${Math.round(account.profitProgress * 100)}%`
                                : '—'}
                            </span>
                          </div>
                          <Bar value={account.profitProgress ?? 0} />
                        </div>
                        <div>
                          <div className="mb-1 flex justify-between text-[11px] text-[#94A3B8]">
                            <span>Max Drawdown</span>
                            <span className="font-mono tabular-nums">{Math.round(account.maxDdUsed * 100)}%</span>
                          </div>
                          <Bar value={account.maxDdUsed} danger={account.isBreached} />
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          {/* Risk & rules + quick links */}
          <div className="space-y-6">
            <Card title="Risk & Rules">
              {selected ? (
                <div className="space-y-5">
                  <div>
                    <div className="mb-2 flex justify-between text-xs">
                      <span className="text-[#94A3B8]">Daily Loss Limit</span>
                      <span className="font-mono tabular-nums text-slate-200">
                        {selected.dailyDrawdownPct.toFixed(2)}% / {selected.dailyLossLimitPct.toFixed(0)}%
                      </span>
                    </div>
                    <Bar value={selected.dailyLossUsed} danger={selected.dailyLossUsed >= 1} />
                  </div>
                  <div>
                    <div className="mb-2 flex justify-between text-xs">
                      <span className="text-[#94A3B8]">Max Trailing Drawdown</span>
                      <span className="font-mono tabular-nums text-slate-200">
                        {selected.maxDrawdownPct.toFixed(2)}% / {selected.maxDdLimitPct.toFixed(0)}%
                      </span>
                    </div>
                    <Bar value={selected.maxDdUsed} danger={selected.maxDdUsed >= 1} />
                  </div>

                  {selected.isBreached && selected.breachReason ? (
                    <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-[#EF4444]">
                      {selected.breachReason}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-[#94A3B8]">Select an account.</p>
              )}
            </Card>

            <Card title="Quick Links">
              <div className="flex flex-col gap-2">
                <Link
                  href="/dashboard/terminal"
                  className="flex items-center justify-between rounded-md border border-slate-800 px-3 py-2.5 text-sm text-slate-200 transition-colors hover:border-slate-600"
                >
                  <span className="inline-flex items-center gap-2">
                    <CandlestickChart className="size-4 text-[#94A3B8]" /> Open Terminal
                  </span>
                  <ArrowUpRight className="size-4 text-[#94A3B8]" />
                </Link>
                <Link
                  href="/dashboard/terminal"
                  className="flex items-center justify-between rounded-md border border-slate-800 px-3 py-2.5 text-sm text-slate-200 transition-colors hover:border-slate-600"
                >
                  <span className="inline-flex items-center gap-2">
                    <Wallet className="size-4 text-[#94A3B8]" /> Payouts
                  </span>
                  <ArrowUpRight className="size-4 text-[#94A3B8]" />
                </Link>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
