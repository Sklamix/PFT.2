'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowUpRight, Check, ChevronDown, Copy, KeyRound, LineChart, Pencil, Plus, RotateCcw, X } from 'lucide-react'
import { useAccounts, type AccountRow, type AccountTrade } from '@/lib/stores/useAccounts'
import { ResetAccountDialog } from '@/components/terminal/ResetAccountDialog'
import { SpaceBackground } from './space-background'
import { cn } from '@/lib/utils'

const BG = '#080C14'
const CARD = '#0C1220'
const LABEL = '#94A3B8'
const GREEN = '#22C55E'
const RED = '#EF4444'

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'funded', label: 'Funded' },
  { id: 'archived', label: 'Archived / Breached' },
] as const

const usd = (n: number) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const signedUsd = (n: number) =>
  `${n >= 0 ? '+' : '-'}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const signedPct = (n: number) => `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(2)}%`

const pnlColor = (n: number) => (n >= 0 ? GREEN : RED)

function Card({
  title,
  children,
  className = '',
}: {
  title?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('rounded-xl border border-slate-800/80 bg-[#0B0F19]/80 p-5 backdrop-blur-md', className)}>
      {title ? (
        <h2 className="mb-4 text-[11px] font-medium uppercase tracking-[0.18em] text-[#94A3B8]">{title}</h2>
      ) : null}
      {children}
    </section>
  )
}

function Bar({
  value,
  label,
  detail,
  danger = false,
  inverse = false,
}: {
  value: number
  label: string
  detail: string
  danger?: boolean
  inverse?: boolean
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)))
  const color = inverse ? (pct < 25 ? RED : LABEL) : danger ? RED : LABEL
  return (
    <div>
      <div className="mb-1 flex justify-between text-[11px] text-[#94A3B8]">
        <span>{label}</span>
        <span className="font-mono tabular-nums" style={{ color: inverse && pct < 25 ? RED : LABEL }}>
          {inverse ? `${pct}% remaining` : `${pct}%`}
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-slate-800">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <p className="mt-1 text-[10px] text-slate-600">{detail}</p>
    </div>
  )
}

function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'live' | 'breach' }) {
  const color = tone === 'breach' ? RED : tone === 'live' ? GREEN : LABEL
  return (
    <span
      className="rounded border border-slate-800 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide"
      style={{ color }}
    >
      {children}
    </span>
  )
}

function CredentialsModal({ account, onClose }: { account: AccountRow; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-slate-800/60 p-6"
        style={{ backgroundColor: CARD }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-100">Trading credentials</h3>
          <button type="button" onClick={onClose} className="text-xs text-[#94A3B8] hover:text-slate-200">
            Close ✕
          </button>
        </div>
        <dl className="mt-5 space-y-3 text-sm">
          {[
            ['Account ID', account.displayId],
            ['Account Login', account.mt5Login],
            ['Server', account.mt5Server],
            ['Platform', account.platform],
            ['Leverage', '1:100'],
          ].map(([term, value]) => (
            <div key={term} className="flex items-center justify-between gap-3 border-b border-slate-800/60 pb-2">
              <dt className="text-[#94A3B8]">{term}</dt>
              <dd className="flex items-center gap-2 font-mono text-xs text-slate-200">
                {value}
                <button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(value)}
                  className="text-slate-600 hover:text-slate-300"
                  aria-label={`Copy ${term}`}
                >
                  <Copy className="size-3.5" />
                </button>
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-[11px] leading-relaxed text-[#94A3B8]">
          Your trading platform password was sent to your registered email when the account was provisioned. We never
          store or display passwords in the web app.
        </p>
      </div>
    </div>
  )
}

function AccountName({ account }: { account: AccountRow }) {
  if (!account.customName?.trim()) {
    return <span className="font-mono text-sm text-slate-100">#{account.displayId}</span>
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate text-sm font-semibold text-slate-100">{account.customName}</span>
      <span className="shrink-0 rounded border border-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-[#94A3B8]">
        #{account.displayId}
      </span>
    </span>
  )
}

function RenameControl({
  account,
  onRenamed,
}: {
  account: AccountRow
  onRenamed: (customName: string | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = () => {
    setValue(account.customName ?? '')
    setError(null)
    setEditing(true)
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/accounts/${encodeURIComponent(account.id)}/rename`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customName: value }),
      })
      const body = (await response.json().catch(() => null)) as { error?: string; customName?: string | null } | null
      if (!response.ok) {
        setError(body?.error ?? 'Unable to rename account.')
      } else {
        setEditing(false)
        onRenamed(body?.customName ?? null)
      }
    } catch {
      setError('Network error. Try again.')
    }
    setBusy(false)
  }

  if (editing) {
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          maxLength={40}
          autoFocus
          placeholder="e.g. Main Challenge 10k"
          className="h-8 w-52 rounded-md border border-slate-800 bg-[#080C14] px-2 text-sm text-slate-200 outline-none focus:border-slate-600"
          aria-label="Custom account name"
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save()
            if (event.key === 'Escape') setEditing(false)
          }}
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="inline-flex h-8 items-center rounded-md border border-slate-700 px-2 text-slate-200 hover:border-slate-500 disabled:opacity-50"
          aria-label="Save name"
        >
          <Check className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="inline-flex h-8 items-center rounded-md px-2 text-[#94A3B8] hover:text-slate-200"
          aria-label="Cancel rename"
        >
          <X className="size-3.5" />
        </button>
        {error ? <span className="w-full text-[11px]" style={{ color: RED }}>{error}</span> : null}
      </span>
    )
  }

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <AccountName account={account} />
      <button
        type="button"
        onClick={start}
        className="rounded p-0.5 text-slate-600 transition-colors hover:text-slate-300"
        aria-label="Rename account"
      >
        <Pencil className="size-3.5" />
      </button>
    </span>
  )
}

function AccountCard({
  account,
  trades,
  expanded,
  onToggleExpand,
  onShowCredentials,
  onReset,
}: {
  account: AccountRow
  trades: AccountTrade[]
  expanded: boolean
  onToggleExpand: () => void
  onShowCredentials: () => void
  onReset: () => void
}) {
  return (
    <Card>
      {/* Account header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <RenameControl
            account={account}
            onRenamed={(customName) => {
              // Update the Zustand store in place, then refresh server figures.
              useAccounts.setState((state) => ({
                data: state.data
                  ? {
                      ...state.data,
                      accounts: state.data.accounts.map((item) =>
                        item.id === account.id
                          ? { ...item, customName, primaryLabel: customName?.trim() || item.displayId }
                          : item,
                      ),
                    }
                  : state.data,
              }))
              void useAccounts.getState().load()
            }}
          />
          <Badge>{account.platform}</Badge>
          <Badge tone={account.isBreached ? 'breach' : account.phase === 'FUNDED' ? 'live' : 'neutral'}>
            {account.phaseLabel}
          </Badge>
        </div>
        <span className="font-mono text-[11px] text-[#94A3B8]">${(account.planSize / 1000).toFixed(0)}k account</span>
      </div>

      {/* Core financials */}
      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        {(
          [
            ['Initial capital', <span key="i" className="font-mono">{usd(account.startingBalance)}</span>],
            ['Balance', <span key="b" className="font-mono">{usd(account.balance)}</span>],
            ['Equity', <span key="e" className="font-mono">{usd(account.equity)}</span>],
            [
              'Net PnL',
              <span key="p" className="font-mono" style={{ color: pnlColor(account.netPnl) }}>
                {signedUsd(account.netPnl)}{' '}
                <span className="text-[11px] opacity-75">({signedPct(account.netPnlPct)})</span>
              </span>,
            ],
          ] as [string, ReactNode][]
        ).map(([label, value]) => (
          <div key={label}>
            <p className="text-[10px] uppercase tracking-[0.16em] text-[#94A3B8]">{label}</p>
            <p className="mt-1 text-sm tabular-nums text-slate-100">{value}</p>
          </div>
        ))}
      </div>

      {/* Compact progress bars */}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Bar
          label="Profit Target"
          value={account.profitProgress ?? 0}
          detail={`Target +${(account.profitTargetPct * 100).toFixed(0)}% · ${usd(account.startingBalance * account.profitTargetPct)}`}
        />
        <Bar
          label="Daily Drawdown"
          value={account.dailyRemaining}
          inverse
          detail={`Limit −${account.dailyLossLimitPct.toFixed(0)}% · used ${account.dailyDrawdownPct.toFixed(2)}%`}
        />
        <Bar
          label="Max Trailing Drawdown"
          value={account.maxDdRemaining}
          inverse
          detail={`Limit −${account.maxDdLimitPct.toFixed(0)}% · used ${account.maxDrawdownPct.toFixed(2)}%`}
        />
      </div>

      {account.isBreached && account.breachReason ? (
        <p className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-[#EF4444]">
          {account.breachReason}
        </p>
      ) : null}

      {/* Actions */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Link
          href={`/dashboard/terminal?account=${encodeURIComponent(account.id)}`}
          className="inline-flex h-8 items-center gap-2 rounded-md border border-slate-800 px-3 text-xs text-slate-300 transition-colors hover:border-slate-600 hover:text-slate-100"
        >
          Open in Terminal <ArrowUpRight className="size-3.5" />
        </Link>
        <button
          type="button"
          onClick={onShowCredentials}
          className="inline-flex h-8 items-center gap-2 rounded-md border border-slate-800 px-3 text-xs text-slate-300 transition-colors hover:border-slate-600 hover:text-slate-100"
        >
          <KeyRound className="size-3.5" /> Credentials
        </button>
        <button
          type="button"
          onClick={onToggleExpand}
          className="inline-flex h-8 items-center gap-2 rounded-md border border-slate-800 px-3 text-xs text-slate-300 transition-colors hover:border-slate-600 hover:text-slate-100"
          aria-expanded={expanded}
        >
          <LineChart className="size-3.5" /> View Analytics
          <ChevronDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />
        </button>
        {account.isBreached ? (
          <button
            type="button"
            onClick={onReset}
            className="inline-flex h-8 items-center gap-2 rounded-md px-3 text-xs font-medium"
            style={{ color: GREEN, border: '1px solid rgba(34,197,94,0.35)', backgroundColor: 'rgba(34,197,94,0.08)' }}
          >
            <RotateCcw className="size-3.5" /> Reset −20%
          </button>
        ) : null}
      </div>

      {/* Expanded trade history */}
      {expanded ? (
        <div className="mt-4 border-t border-slate-800/60 pt-4">
          {trades.length === 0 ? (
            <p className="text-xs text-[#94A3B8]">No closed trades yet on this account.</p>
          ) : (
            <ul className="divide-y divide-slate-800/60 text-xs">
              {trades.map((trade) => (
                <li key={trade.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="font-mono text-slate-200">{trade.symbol}</span>
                  <span className="text-[#94A3B8]">
                    {trade.side} · {trade.sizeLots.toFixed(2)} lots
                  </span>
                  <span className="font-mono tabular-nums" style={{ color: pnlColor(trade.pnl) }}>
                    {signedUsd(trade.pnl)}
                  </span>
                  <span className="font-mono text-[10px] text-slate-600">
                    {new Date(trade.closedAt).toLocaleString('en-GB', {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </Card>
  )
}

export function AccountsView() {
  const data = useAccounts((state) => state.data)
  const loadState = useAccounts((state) => state.loadState)
  const error = useAccounts((state) => state.error)
  const filter = useAccounts((state) => state.filter)
  const expandedId = useAccounts((state) => state.expandedId)
  const load = useAccounts((state) => state.load)
  const setFilter = useAccounts((state) => state.setFilter)
  const toggleExpanded = useAccounts((state) => state.toggleExpanded)
  const [credentialsId, setCredentialsId] = useState<string | null>(null)
  const [resetId, setResetId] = useState<string | null>(null)

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 10_000)
    return () => window.clearInterval(timer)
  }, [load])

  const accounts = data?.accounts ?? []
  const trades = data?.trades ?? {}
  const visible = filter === 'all' ? accounts : accounts.filter((account) => account.category === filter)
  const counts = {
    all: accounts.length,
    active: accounts.filter((account) => account.category === 'active').length,
    funded: accounts.filter((account) => account.category === 'funded').length,
    archived: accounts.filter((account) => account.category === 'archived').length,
  }
  const credentialsAccount = accounts.find((account) => account.id === credentialsId) ?? null

  return (
    <div className="min-h-dvh">
      <SpaceBackground />
      <div className="relative z-10 mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Header bar */}
        <header className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-lg font-semibold tracking-tight text-slate-100">Trading Accounts</h1>
          <div className="flex items-center gap-4">
            <nav className="flex items-center gap-1" aria-label="Filter accounts">
              {FILTERS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setFilter(tab.id)}
                  aria-pressed={filter === tab.id}
                  className={cn(
                    'h-8 rounded-md px-3 text-xs transition-colors',
                    filter === tab.id
                      ? 'bg-slate-800/60 text-slate-100'
                      : 'text-[#94A3B8] hover:text-slate-200',
                  )}
                >
                  {tab.label} <span className="font-mono text-[10px] opacity-60">{counts[tab.id]}</span>
                </button>
              ))}
            </nav>
            <Link
              href="/dashboard/terminal"
              className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-800 px-3 text-sm text-slate-200 transition-colors hover:border-slate-600 hover:text-slate-100"
            >
              <Plus className="size-4" /> Buy New Challenge
            </Link>
          </div>
        </header>

        {/* Account grid */}
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          {loadState === 'error' ? (
            <div className="lg:col-span-2">
              <p className="text-sm text-[#94A3B8]">{error ?? 'Unable to load trading accounts.'}</p>
            </div>
          ) : loadState !== 'ready' ? (
            <p className="text-sm text-[#94A3B8]">Loading accounts…</p>
          ) : visible.length === 0 ? (
            <div className="rounded-xl border border-slate-800/80 bg-[#0B0F19]/80 p-10 text-center backdrop-blur-md">
              <p className="text-sm text-[#94A3B8]">
                {filter === 'all'
                  ? 'No trading accounts yet — buy a challenge to get started.'
                  : `No ${filter} accounts.`}
              </p>
              <Link
                href="/dashboard/terminal"
                className="mt-4 inline-flex h-9 items-center gap-2 rounded-md border border-slate-800 px-4 text-sm text-slate-200 hover:border-slate-600"
              >
                <Plus className="size-4" /> Buy New Challenge
              </Link>
            </div>
          ) : (
            visible.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                trades={trades[account.id] ?? []}
                expanded={expandedId === account.id}
                onToggleExpand={() => toggleExpanded(account.id)}
                onShowCredentials={() => setCredentialsId(account.id)}
                onReset={() => setResetId(account.id)}
              />
            ))
          )}
        </div>
      </div>

      {credentialsAccount ? (
        <CredentialsModal account={credentialsAccount} onClose={() => setCredentialsId(null)} />
      ) : null}
      {resetId ? <ResetAccountDialog accountId={resetId} open onOpenChange={(open) => !open && setResetId(null)} /> : null}
    </div>
  )
}
