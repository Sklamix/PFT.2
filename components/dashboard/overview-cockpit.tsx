'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import {
  ArrowUpRight,
  Banknote,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Layers,
  List,
  Shield,
  ShieldCheck,
  SquareArrowOutUpRight,
  SquareTerminal,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useOverview, type OverviewAccount } from '@/lib/stores/useOverview'
import { useSelectedAccount } from '@/lib/stores/useSelectedAccount'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { SpaceBackground } from './space-background'

const BLUE = '#307DFD'
const GREEN = '#22D39B'
const RED = '#E14C55'
const TEXT = '#F4F7FF'
const MUTED = '#8FA3C4'
const DIM = '#66748E'
const BG = '#0C1426'

const SURFACE = { background: 'linear-gradient(180deg,#0C1426,#0A0F1C)' }

const usd = (n: number) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const signedUsd = (n: number) =>
  `${n >= 0 ? '+' : '-'}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const PASSED_STATUSES = ['PASSED', 'PASSED_PHASE_1', 'PASSED_PHASE_2']

function phaseLabel(account: OverviewAccount): string {
  if (PASSED_STATUSES.includes(account.status)) return 'PASSED'
  if (account.status === 'EXPIRED') return 'EXPIRED'
  if (account.isBreached) return 'BREACHED'
  if (account.phase === 'FUNDED') return 'FUNDED'
  if (account.phase === 'PHASE_2') return 'PHASE 2'
  return 'PHASE 1'
}

function Card({
  icon: Icon,
  title,
  children,
  className = '',
}: {
  icon: LucideIcon
  title: string
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={`relative overflow-hidden rounded-[14px] border border-white/[0.07] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] backdrop-blur-md ${className}`}
      style={SURFACE}
    >
      <h2 className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#B9C7DE]">
        <Icon className="size-3.5" style={{ color: BLUE }} strokeWidth={1.75} aria-hidden="true" />
        {title}
      </h2>
      {children}
    </section>
  )
}

function Bar({ value, danger = false }: { value: number; danger?: boolean }) {
  const width = Math.max(0, Math.min(100, Math.round(value * 100)))
  return (
    <div className="h-1 w-full max-w-[320px] overflow-hidden rounded-full bg-white/[0.06]">
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${width}%`, backgroundColor: danger ? RED : BLUE }}
      />
    </div>
  )
}

function Money({
  value,
  color,
  signed = false,
  mutedCents = false,
}: {
  value: number
  color: string
  signed?: boolean
  mutedCents?: boolean
}) {
  const text = signed ? signedUsd(value) : usd(value)
  const dot = text.lastIndexOf('.')
  if (dot < 0) return <span style={{ color }}>{text}</span>
  return (
    <span style={{ color }}>
      {text.slice(0, dot)}
      <span style={{ color: mutedCents ? color : DIM, opacity: mutedCents ? 0.55 : 1 }}>
        {text.slice(dot)}
      </span>
    </span>
  )
}

function Kpi({
  label,
  icon: Icon,
  tone,
  children,
}: {
  label: string
  icon: LucideIcon
  tone: string
  children: ReactNode
}) {
  return (
    <div
      className="relative h-[96px] overflow-hidden rounded-[14px] border border-white/[0.07] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] backdrop-blur-md"
      style={SURFACE}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(120% 100% at 0% 0%, rgba(48,125,253,0.10), transparent 60%)' }}
      />
      <div className="relative flex h-full flex-col">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8FA3C4]">{label}</p>
        <Icon
          className="absolute right-4 top-4 size-4"
          style={{ color: tone }}
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <div className="mt-3 text-[26px] font-semibold leading-none tracking-[-0.02em] tabular-nums">
          {children}
        </div>
      </div>
    </div>
  )
}

const BADGE_TONES: Record<string, { text: string; border: string; background: string }> = {
  BREACHED: { text: RED, border: 'rgba(225,76,85,0.35)', background: 'rgba(225,76,85,0.10)' },
  EXPIRED: { text: RED, border: 'rgba(225,76,85,0.35)', background: 'rgba(225,76,85,0.10)' },
  PASSED: { text: GREEN, border: 'rgba(34,211,155,0.35)', background: 'rgba(34,211,155,0.10)' },
  FUNDED: { text: '#7FA9FF', border: 'rgba(127,169,255,0.35)', background: 'rgba(127,169,255,0.10)' },
}

function StatusBadge({ label }: { label: string }) {
  const tone = BADGE_TONES[label] ?? {
    text: MUTED,
    border: 'rgba(143,163,196,0.35)',
    background: 'rgba(143,163,196,0.10)',
  }
  return (
    <span
      className="inline-flex h-[19px] shrink-0 items-center rounded-full border px-2 text-[9px] font-bold uppercase tracking-[0.08em]"
      style={{ color: tone.text, borderColor: tone.border, backgroundColor: tone.background }}
    >
      {label}
    </span>
  )
}

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: number }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-[10px] border border-white/[0.07] bg-[#0C1426] px-3 py-2 text-xs shadow-[0_8px_24px_rgba(0,0,0,0.35)]">
      <p className="text-[#8FA3C4]">
        {new Date(Number(label)).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
      </p>
      <p className="font-mono tabular-nums text-[#F4F7FF]">{usd(Number(payload[0].value))}</p>
    </div>
  )
}

export function OverviewCockpit() {
  const data = useOverview((state) => state.data)
  const loadState = useOverview((state) => state.loadState)
  const error = useOverview((state) => state.error)
  const selectedId = useOverview((state) => state.selectedAccountId)
  const load = useOverview((state) => state.load)

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(timer)
  }, [load])

  const accounts = data?.accounts ?? []
  // Global selection is the single source of truth (shared with Payouts page).
  const globalAccountId = useSelectedAccount((state) => state.accountId)
  const globalSelect = useSelectedAccount((state) => state.select)
  const effectiveId = accounts.some((account) => account.id === globalAccountId)
    ? globalAccountId
    : (selectedId || accounts[0]?.id || '')
  const selected = accounts.find((account) => account.id === effectiveId) ?? accounts[0]
  const curve = selected && data?.curves ? (data.curves[selected.id] ?? []) : []
  const rawStep = Math.max(1, Math.max(0, ...curve.map((point) => point.equity)) / 3)
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const step = Math.ceil(rawStep / magnitude) * magnitude
  const axisMax = step * 3
  const axisTicks = [0, step, step * 2, axisMax]

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
      <SpaceBackground variant="planet" />
      <div className="relative z-10 mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Header */}
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <div>
              <h1 className="text-[20px] font-semibold tracking-[-0.01em] text-[#F4F7FF]">Overview</h1>
              <p className="mt-1 text-[12px] text-[#8FA3C4]">Equity, PnL and drawdown guards at a glance.</p>
            </div>
            {selected && (
              <div className="ml-14">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    className="inline-flex h-8 items-center gap-2 rounded-full border border-white/[0.08] bg-[rgba(11,18,36,0.7)] px-3 text-[12px] font-semibold tabular-nums text-[#E7EDFF] outline-none transition-colors hover:border-white/[0.16] focus-visible:border-white/[0.16] aria-expanded:border-white/[0.16]"
                    aria-label={`Active account ${selected.displayId}. Change account`}
                  >
                    <ShieldCheck className="size-[13px]" style={{ color: BLUE }} strokeWidth={1.75} aria-hidden="true" />
                    <span>{selected.primaryLabel}</span>
                    <span className="text-[11px] font-normal text-[#8FA3C4]">({phaseLabel(selected)})</span>
                    <ChevronDown className="size-3 text-[#8FA3C4]" aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-72 border-slate-800 bg-[#0B0F19]">
                    <DropdownMenuRadioGroup value={selected.id} onValueChange={(value) => globalSelect(String(value))}>
                      {accounts.map((account) => (
                        <DropdownMenuRadioItem key={account.id} value={account.id} className="gap-0 py-2">
                          <div className="flex min-w-0 flex-col gap-0.5">
                            <span className="flex items-center gap-2 font-mono text-xs font-semibold text-slate-100">
                              <span
                                className="inline-block size-1.5 rounded-full"
                                style={{ backgroundColor: account.isBreached ? RED : GREEN }}
                                aria-hidden="true"
                              />
                              {account.primaryLabel}
                              {account.customName?.trim() ? (
                                <span className="font-mono text-[10px] font-normal text-slate-500">#{account.displayId}</span>
                              ) : null}
                            </span>
                            <span className="flex items-center gap-2 text-[11px] text-[#8FA3C4]">
                              {phaseLabel(account)} · <span className="font-mono tabular-nums">{usd(account.equity)}</span>
                            </span>
                          </div>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>
          <div className="ml-auto flex items-center gap-3">
            <Link
              href={selected ? `/dashboard/terminal?account=${encodeURIComponent(selected.id)}` : '/dashboard/terminal'}
              className="inline-flex h-9 items-center gap-2 rounded-[10px] border border-white/[0.10] bg-white/[0.02] px-3.5 text-[12.5px] font-medium text-[#DCE6F7] transition-colors hover:border-white/[0.20] hover:bg-white/[0.05]"
            >
              <SquareArrowOutUpRight className="size-3.5" aria-hidden="true" /> Open Terminal
            </Link>
          </div>
        </header>

        {/* KPI row */}
        <div className="mt-[22px] grid grid-cols-2 gap-[22px] lg:grid-cols-4">
          <Kpi label="Equity" icon={ArrowUpRight} tone={BLUE}>
            {selected ? <Money value={selected.equity} color={TEXT} /> : '—'}
          </Kpi>
          <Kpi label="Profit / PnL" icon={TrendingUp} tone={GREEN}>
            {selected ? <Money value={selected.todayPnl} color={pnlColor(selected.todayPnl)} signed mutedCents /> : '—'}
          </Kpi>
          <Kpi label="Total PnL" icon={TrendingDown} tone={RED}>
            {selected ? <Money value={selected.totalPnl} color={pnlColor(selected.totalPnl)} signed mutedCents /> : '—'}
          </Kpi>
          <Kpi label="Status" icon={ShieldCheck} tone={GREEN}>
            {selected ? (
              <span
                className="flex items-center gap-2 text-[18px] font-semibold"
                style={{ color: selected.isBreached ? RED : GREEN }}
              >
                <span className="size-[7px] rounded-full" style={{ backgroundColor: selected.isBreached ? RED : GREEN }} aria-hidden="true" />
                {phaseLabel(selected)}
              </span>
            ) : (
              '—'
            )}
          </Kpi>
        </div>

        {/* Main grid */}
        <div className="mt-[22px] grid gap-[22px] lg:grid-cols-3">
          <div className="space-y-[22px] lg:col-span-2">
            {/* Equity curve */}
            <Card icon={BarChart3} title="Equity Curve" className="h-[252px] p-4">
              {curve.length > 1 ? (
                <div className="mt-3 h-[190px] w-full [&_.recharts-area-curve]:[filter:drop-shadow(0_0_6px_rgba(48,125,253,0.55))]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={curve} margin={{ top: 6, right: 0, bottom: 0, left: 0 }}>
                      <defs>
                        <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#307DFD" stopOpacity={0.35} />
                          <stop offset="100%" stopColor="#307DFD" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="rgba(255,255,255,0.04)" />
                      <XAxis dataKey="t" hide type="number" domain={['dataMin', 'dataMax']} />
                      <YAxis
                        orientation="right"
                        width={40}
                        domain={[0, axisMax]}
                        ticks={axisTicks}
                        interval={0}
                        allowDecimals={false}
                        axisLine={false}
                        tickLine={false}
                        tick={{ fill: '#8FA3C4', fontSize: 11 }}
                        tickMargin={8}
                        tickFormatter={(value: number) => (value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : String(value))}
                      />
                      <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#334155', strokeDasharray: '3 3' }} />
                      <Area
                        type="monotone"
                        dataKey="equity"
                        stroke="#4C8DFF"
                        strokeWidth={2}
                        fill="url(#equityFill)"
                        dot={false}
                        activeDot={{ r: 3, fill: '#4C8DFF', stroke: BG }}
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="mt-3 text-sm text-[#8FA3C4]">No closed trades yet — the curve starts once you place a trade.</p>
              )}
            </Card>

            {/* Active accounts */}
            <Card icon={List} title="Active Accounts" className="p-3">
              {accounts.length === 0 ? (
                <p className="px-1 py-2 text-sm text-[#8FA3C4]">No accounts yet.</p>
              ) : (
                <ul className="mt-1 divide-y divide-white/[0.05]">
                  {accounts.map((account) => (
                    <li key={account.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_auto_36px] items-center gap-4 py-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-[12.5px] font-semibold text-[#F4F7FF]">{account.displayId}</span>
                        <StatusBadge label={phaseLabel(account)} />
                      </div>
                      <Bar value={account.profitProgress ?? 0} danger={account.isBreached} />
                      <div className="whitespace-nowrap text-[11px] tabular-nums text-[#DCE6F7]">
                        {usd(account.equity)} <span className="text-[#66748E]">/ ${(account.planSize / 1000).toFixed(0)}k</span>
                      </div>
                      <div className="text-right text-[10.5px] tabular-nums text-[#8FA3C4]">
                        {account.profitProgress != null ? `${Math.round(account.profitProgress * 100)}%` : '—'}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          {/* Risk & rules + quick links */}
          <div className="space-y-[22px]">
            <Card icon={Shield} title="Risk & Rules" className="p-4">
              {selected ? (
                <div className="mt-3">
                  <div className="flex h-8 items-center justify-between gap-3">
                    <span className="text-[11.5px] text-[#8FA3C4]">Daily Loss Limit</span>
                    <span className="flex items-center gap-1.5 text-[11.5px] font-bold tabular-nums text-[#F4F7FF]">
                      {selected.dailyDrawdownPct.toFixed(2)}%
                      <span className="text-[#66748E]">/ {selected.dailyLossLimitPct.toFixed(0)}%</span>
                    </span>
                  </div>
                  <div className="h-px bg-white/[0.06]" />
                  <div className="flex h-8 items-center justify-between gap-3">
                    <span className="text-[11.5px] text-[#8FA3C4]">Max Trailing Drawdown</span>
                    <span className="flex items-center gap-1.5 text-[11.5px] font-bold tabular-nums text-[#F4F7FF]">
                      {selected.maxDrawdownPct.toFixed(2)}%
                      <span className="text-[#66748E]">/ {selected.maxDdLimitPct.toFixed(0)}%</span>
                    </span>
                  </div>

                  {selected.isBreached && selected.breachReason ? (
                    <p className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-[#EF4444]">
                      {selected.breachReason}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="mt-3 text-sm text-[#8FA3C4]">Select an account.</p>
              )}
            </Card>

            <Card icon={Layers} title="Quick Links" className="p-4">
              <div className="mt-3 flex flex-col gap-2">
                <Link
                  href="/dashboard/terminal"
                  className="flex h-10 items-center gap-3 rounded-[10px] border border-white/[0.06] bg-white/[0.02] px-3 transition-colors hover:border-white/[0.15] hover:bg-white/[0.04]"
                >
                  <span className="flex size-[22px] shrink-0 items-center justify-center rounded-md bg-[rgba(48,125,253,0.12)]">
                    <SquareTerminal className="size-3 text-[#7FA9FF]" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 text-[12px] text-[#DCE6F7]">Open Terminal</span>
                  <ChevronRight className="size-3.5 text-[#66748E]" aria-hidden="true" />
                </Link>
                <Link
                  href="/dashboard/terminal"
                  className="flex h-10 items-center gap-3 rounded-[10px] border border-white/[0.06] bg-white/[0.02] px-3 transition-colors hover:border-white/[0.15] hover:bg-white/[0.04]"
                >
                  <span className="flex size-[22px] shrink-0 items-center justify-center rounded-md bg-[rgba(48,125,253,0.12)]">
                    <Banknote className="size-3 text-[#7FA9FF]" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 text-[12px] text-[#DCE6F7]">Payouts</span>
                  <ChevronRight className="size-3.5 text-[#66748E]" aria-hidden="true" />
                </Link>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
