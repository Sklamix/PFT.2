'use client'

import { useState } from 'react'
import { ArrowRight, BadgeCheck, FileText, Fingerprint, MapPin } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ACCOUNTS, ORDERS, PAYOUT_HISTORY, TRADES, formatPct, formatUsd, getMetrics, type TradingAccount } from '@/lib/dashboard-data'
import { cn } from '@/lib/utils'
import { PayoutCard } from './payout-card'
import { StatusDot } from './status-dot'
import { TradesLedger } from './trades-ledger'

export function ViewHeading({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight text-foreground text-balance">{title}</h1>
      <p className="mt-1 text-sm text-muted-foreground text-pretty">{description}</p>
    </div>
  )
}

export function AccountsView({ activeId, onSelect }: { activeId: string; onSelect: (id: string) => void }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {ACCOUNTS.map((account) => {
        const metrics = getMetrics(account)
        const active = account.id === activeId
        return (
          <article key={account.id} className={cn('flex flex-col gap-4 rounded-xl border bg-card p-5', active ? 'border-primary/40' : 'border-border')}>
            <header className="flex items-start justify-between gap-2">
              <div>
                <p className="font-mono text-sm font-semibold text-foreground">{account.id}</p>
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <StatusDot status={account.status} />
                  {account.statusLabel}
                </p>
              </div>
              <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{account.phase}</span>
            </header>
            <dl className="grid grid-cols-2 gap-3 font-mono text-xs">
              <div>
                <dt className="text-muted-foreground">Equity</dt>
                <dd className="mt-0.5 text-base font-semibold text-foreground tabular-nums">{formatUsd(account.equity, { compact: true })}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Return</dt>
                <dd className={cn('mt-0.5 text-base font-semibold tabular-nums', metrics.profitPct >= 0 ? 'text-primary' : 'text-danger')}>
                  {formatPct(metrics.profitPct, true)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Program</dt>
                <dd className="mt-0.5 text-foreground">{formatUsd(account.size, { compact: true })} {account.program}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Server</dt>
                <dd className="mt-0.5 truncate text-foreground">{account.server}</dd>
              </div>
            </dl>
            <Button variant={active ? 'secondary' : 'outline'} className="mt-auto" onClick={() => onSelect(account.id)}>
              {active ? 'Open cockpit' : 'Switch to account'}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Button>
          </article>
        )
      })}
    </div>
  )
}

export function PayoutsView({ account, onRequestPayout }: { account: TradingAccount; onRequestPayout: () => void }) {
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <PayoutCard account={account} onRequestPayout={onRequestPayout} />
      <section aria-labelledby="payout-history" className="rounded-xl border border-border bg-card p-5 xl:col-span-2">
        <h2 id="payout-history" className="text-base font-semibold text-foreground">Disbursement history</h2>
        <p className="text-sm text-muted-foreground">Completed payouts across all funded accounts</p>
        <Table className="mt-4 font-mono text-xs">
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="text-muted-foreground">ID</TableHead>
              <TableHead className="text-muted-foreground">Date</TableHead>
              <TableHead className="hidden text-muted-foreground sm:table-cell">Method</TableHead>
              <TableHead className="text-right text-muted-foreground">Amount</TableHead>
              <TableHead className="text-right text-muted-foreground">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {PAYOUT_HISTORY.map((payout) => (
              <TableRow key={payout.id} className="border-border">
                <TableCell className="text-foreground">{payout.id}</TableCell>
                <TableCell className="text-muted-foreground">{payout.date}</TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">{payout.method}</TableCell>
                <TableCell className="text-right font-semibold text-primary tabular-nums">{formatUsd(payout.amount)}</TableCell>
                <TableCell className="text-right">
                  <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary">{payout.status}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </div>
  )
}

export function JournalView({ account }: { account: TradingAccount }) {
  const trades = TRADES[account.id] ?? []
  const wins = trades.filter((trade) => trade.net >= 0)
  const losses = trades.filter((trade) => trade.net < 0)
  const average = (list: typeof trades) => (list.length ? list.reduce((sum, trade) => sum + trade.net, 0) / list.length : 0)
  const grossWin = wins.reduce((sum, trade) => sum + trade.net, 0)
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.net, 0))
  const stats = [
    { label: 'Win rate', value: trades.length ? `${Math.round((wins.length / trades.length) * 100)}%` : '—' },
    { label: 'Avg. winner', value: formatUsd(average(wins), { signed: true }), tone: 'text-primary' },
    { label: 'Avg. loser', value: formatUsd(average(losses), { signed: true }), tone: 'text-danger' },
    { label: 'Profit factor', value: grossLoss ? (grossWin / grossLoss).toFixed(2) : '—' },
  ]

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-xl border border-border bg-card p-4">
            <dt className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{stat.label}</dt>
            <dd className={cn('mt-1 font-mono text-xl font-semibold tabular-nums', stat.tone ?? 'text-foreground')}>{stat.value}</dd>
          </div>
        ))}
      </dl>
      <TradesLedger account={account} title="Trade Journal" />
    </div>
  )
}

export function BillingView() {
  return (
    <section aria-labelledby="orders-title" className="rounded-xl border border-border bg-card p-5">
      <h2 id="orders-title" className="text-base font-semibold text-foreground">Orders</h2>
      <p className="text-sm text-muted-foreground">Challenge purchases and refunds</p>
      <Table className="mt-4 font-mono text-xs">
        <TableHeader>
          <TableRow className="border-border hover:bg-transparent">
            <TableHead className="text-muted-foreground">Order</TableHead>
            <TableHead className="text-muted-foreground">Item</TableHead>
            <TableHead className="hidden text-muted-foreground sm:table-cell">Date</TableHead>
            <TableHead className="text-right text-muted-foreground">Amount</TableHead>
            <TableHead className="text-right text-muted-foreground">Invoice</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ORDERS.map((order) => (
            <TableRow key={order.id} className="border-border">
              <TableCell className="text-foreground">{order.id}</TableCell>
              <TableCell className="text-foreground">
                {order.item}
                <span className={cn('ml-2 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', order.status === 'Paid' ? 'bg-secondary text-muted-foreground' : 'bg-highlight/15 text-highlight')}>
                  {order.status}
                </span>
              </TableCell>
              <TableCell className="hidden text-muted-foreground sm:table-cell">{order.date}</TableCell>
              <TableCell className="text-right tabular-nums text-foreground">{formatUsd(order.amount)}</TableCell>
              <TableCell className="text-right">
                <Button variant="ghost" size="icon-sm" aria-label={`Download invoice ${order.id}`}>
                  <FileText className="size-4" aria-hidden="true" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  )
}

const PREFERENCES = [
  { id: 'two-factor', label: 'Two-factor authentication', description: 'Require an authenticator code at sign-in.', defaultOn: true },
  { id: 'breach-alerts', label: 'Drawdown proximity alerts', description: 'Email and push when a buffer drops below 25%.', defaultOn: true },
  { id: 'daily-report', label: 'Daily performance report', description: 'Receive a summary after each 00:00 UTC reset.', defaultOn: false },
  { id: 'news-lock', label: 'High-impact news reminders', description: 'Warn 5 minutes before red-folder events.', defaultOn: true },
]

export function SettingsView() {
  const [prefs, setPrefs] = useState<Record<string, boolean>>(() => Object.fromEntries(PREFERENCES.map((pref) => [pref.id, pref.defaultOn])))
  const kyc = [
    { label: 'Identity document', icon: Fingerprint, status: 'Verified' },
    { label: 'Proof of address', icon: MapPin, status: 'Verified' },
    { label: 'Trader agreement', icon: FileText, status: 'Signed' },
  ]

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <section aria-labelledby="kyc-title" className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center justify-between">
          <h2 id="kyc-title" className="text-base font-semibold text-foreground">KYC verification</h2>
          <span className="flex items-center gap-1 rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase text-primary">
            <BadgeCheck className="size-3" aria-hidden="true" />
            Approved
          </span>
        </div>
        <ul className="mt-4 flex flex-col gap-2">
          {kyc.map((item) => (
            <li key={item.label} className="flex items-center gap-3 rounded-lg border border-border bg-background/60 p-3">
              <item.icon className="size-4 text-highlight" aria-hidden="true" />
              <span className="flex-1 text-sm text-foreground">{item.label}</span>
              <span className="font-mono text-xs text-primary">{item.status}</span>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="prefs-title" className="rounded-xl border border-border bg-card p-5">
        <h2 id="prefs-title" className="text-base font-semibold text-foreground">Security & notifications</h2>
        <ul className="mt-4 flex flex-col divide-y divide-border">
          {PREFERENCES.map((pref) => (
            <li key={pref.id} className="flex items-center justify-between gap-4 py-3">
              <label htmlFor={pref.id} className="cursor-pointer">
                <span className="block text-sm text-foreground">{pref.label}</span>
                <span className="block text-xs text-muted-foreground">{pref.description}</span>
              </label>
              <Switch id={pref.id} checked={prefs[pref.id]} onCheckedChange={(checked) => setPrefs((state) => ({ ...state, [pref.id]: checked }))} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
