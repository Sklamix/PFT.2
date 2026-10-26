'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { LogOut, ReceiptText, Search, Wallet } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { AdminDeskFrame } from '@/components/admin/admin-desk-frame'
import { KpiBar } from '@/components/admin/kpi-bar'
import { KycDialog } from '@/components/admin/kyc-dialog'
import { OrdersQueue } from '@/components/admin/orders-queue'
import { PayoutQueue } from '@/components/admin/payout-queue'
import { PayoutsManagement } from '@/components/admin/payouts-management'
import { RiskTable } from '@/components/admin/risk-table'
import { TradingConditionsManagement } from '@/components/admin/trading-conditions-management'
import { TelemetryController } from '@/components/admin/telemetry-controller'
import { TradeHistoryModal } from '@/components/admin/trade-history-modal'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type {
  AccountStatus,
  AdminSession,
  OverviewMetrics,
  OrderRow,
  PayoutRow,
  TelemetryState,
  TradeRow,
  TraderFilter,
  TraderRow,
} from '@/lib/admin/types'

const FILTERS: { id: TraderFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'near_limit', label: 'Near Limit (Alerts)' },
  { id: 'breached', label: 'Breached' },
  { id: 'passing', label: 'Active - Passing' },
]

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Request failed')
  return data as T
}

export function AdminDesk({ user }: { user: AdminSession }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<TraderFilter>('all')
  const [metrics, setMetrics] = useState<OverviewMetrics | null>(null)
  const [rows, setRows] = useState<TraderRow[]>([])
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [payouts, setPayouts] = useState<PayoutRow[]>([])
  const [telemetry, setTelemetry] = useState<TelemetryState | null>(null)
  const [queueOpen, setQueueOpen] = useState(false)
  const [ordersOpen, setOrdersOpen] = useState(false)
  const [selected, setSelected] = useState<TraderRow | null>(null)
  const [trades, setTrades] = useState<TradeRow[]>([])
  const [tradesOpen, setTradesOpen] = useState(false)
  const [breachOpen, setBreachOpen] = useState(false)
  const [kycOpen, setKycOpen] = useState(false)
  const [kycUserId, setKycUserId] = useState<string | null>(null)
  const [overrideOpen, setOverrideOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [overrideStatus, setOverrideStatus] = useState<AccountStatus>('ACTIVE')
  const [error, setError] = useState<string | null>(null)
  const [breachType, setBreachType] = useState<'BREACHED_DAILY' | 'BREACHED_MAX'>('BREACHED_DAILY')

  const load = useCallback(async () => {
    try {
      const [overview, traders, queue, orderRows, pulse] = await Promise.all([
        api<OverviewMetrics>('/api/admin/metrics/overview'),
        api<{ items: TraderRow[] }>(`/api/admin/traders?q=${encodeURIComponent(query)}&filter=${filter}`),
        api<{ items: PayoutRow[] }>('/api/admin/payouts'),
        api<{ items: OrderRow[] }>('/api/admin/orders'),
        api<TelemetryState>('/api/admin/telemetry'),
      ])
      setMetrics(overview)
      setRows(traders.items)
      setPayouts(queue.items)
      setOrders(orderRows.items)
      setTelemetry(pulse)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load operations desk')
    }
  }, [filter, query])

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void load()
    }, 200)
    return () => window.clearTimeout(handle)
  }, [load])

  useEffect(() => {
    const pulse = window.setInterval(() => {
      void load()
    }, 20_000)
    return () => window.clearInterval(pulse)
  }, [load])

  async function logout() {
    await fetch('/api/admin/auth/logout', { method: 'POST' })
    router.replace('/admin/login')
    router.refresh()
  }

  return (
    <AdminDeskFrame
      user={user}
      actions={
        <>
          {user.role === 'ADMIN' && (
            <Link
              href="/admin/pricing"
              className="inline-flex h-7 items-center justify-center rounded-md border border-border bg-background px-2.5 text-[0.8rem] font-medium hover:bg-muted"
            >
              2-Step pricing
            </Link>
          )}
          <Button variant="outline" size="sm" onClick={() => setQueueOpen(true)}>
            <Wallet />
            Payout queue
            {metrics ? ` (${metrics.pendingPayoutsCount})` : ''}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setOrdersOpen(true)}>
            <ReceiptText />
            Orders &amp; payments
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void logout()}>
            <LogOut />
            Sign out
          </Button>
        </>
      }
    >
      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}

      <KpiBar metrics={metrics} />
      <TelemetryController state={telemetry} />
      <PayoutsManagement canManage={user.role === 'ADMIN'} />
      <TradingConditionsManagement canManage={user.role === 'ADMIN'} />

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">Active trader drawdown risk monitor</h2>
            <p className="text-xs text-muted-foreground">Live books ranked by daily guardrail consumption.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search account, MT5 login, email"
                className="h-8 w-full rounded-md border border-border bg-background pr-3 pl-8 text-sm sm:w-72"
              />
            </label>
            <div className="flex flex-wrap gap-1">
              {FILTERS.map((item) => (
                <Button
                  key={item.id}
                  size="xs"
                  variant={filter === item.id ? 'default' : 'outline'}
                  onClick={() => setFilter(item.id)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          </div>
        </div>

        <RiskTable
          rows={rows}
          onTrades={async (row) => {
            try {
              const data = await api<{ trades: TradeRow[] }>(`/api/admin/accounts/${row.id}/trades`)
              setSelected(row)
              setTrades(data.trades)
              setTradesOpen(true)
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Unable to load trade ledger')
            }
          }}
          onRefresh={async (row) => {
            try {
              await api(`/api/admin/accounts/${row.id}/refresh`, { method: 'POST' })
              await load()
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Telemetry refresh failed')
            }
          }}
          onBreach={(row) => {
            setSelected(row)
            setReason('')
            setBreachType(row.dailyDrawdownPct / row.dailyDrawdownLimitPct >= row.maxDrawdownPct / row.maxDrawdownLimitPct ? 'BREACHED_DAILY' : 'BREACHED_MAX')
            setBreachOpen(true)
          }}
          onKyc={(row) => {
            setKycUserId(row.userId)
            setKycOpen(true)
          }}
          onOverride={(row) => {
            setSelected(row)
            setOverrideStatus(row.status)
            setReason('Manual operations override')
            setOverrideOpen(true)
          }}
        />
      </section>

      <PayoutQueue
        open={queueOpen}
        onOpenChange={setQueueOpen}
        items={payouts}
        canApprove={user.role === 'ADMIN'}
        onApprove={async (id, txHash) => {
          try {
            await api(`/api/admin/payouts/${id}/approve`, { method: 'POST', body: JSON.stringify({ txHash }) })
            await load()
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Payout approval failed')
            throw err
          }
        }}
      />

      <OrdersQueue open={ordersOpen} onOpenChange={setOrdersOpen} items={orders} />

      <TradeHistoryModal open={tradesOpen} onOpenChange={setTradesOpen} account={selected} trades={trades} />

      <Dialog open={breachOpen} onOpenChange={setBreachOpen}>
        <DialogContent className="border-border bg-card sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Kill-switch {selected?.displayId}</DialogTitle>
            <DialogDescription>Freeze the book, mark open lots for liquidation, and write an audit reason.</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            {(['BREACHED_DAILY', 'BREACHED_MAX'] as const).map((type) => (
              <Button key={type} size="xs" variant={breachType === type ? 'destructive' : 'outline'} onClick={() => setBreachType(type)}>
                {type === 'BREACHED_DAILY' ? 'Daily kill-switch' : 'Max DD kill-switch'}
              </Button>
            ))}
          </div>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="min-h-24 rounded-md border border-border bg-background p-2 text-sm"
            placeholder="Breach reason"
          />
          <DialogFooter>
            <Button
              variant="destructive"
              disabled={!reason.trim()}
              onClick={async () => {
                if (!selected) return
                try {
                  await api(`/api/admin/accounts/${selected.id}/breach`, {
                    method: 'POST',
                    body: JSON.stringify({ type: breachType, reason }),
                  })
                  setBreachOpen(false)
                  await load()
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Kill-switch failed')
                }
              }}
            >
              Freeze account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <KycDialog
        open={kycOpen}
        onOpenChange={setKycOpen}
        userId={kycUserId}
        onSaved={() => void load()}
      />

      <Dialog open={overrideOpen} onOpenChange={setOverrideOpen}>
        <DialogContent className="border-border bg-card sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Override {selected?.displayId}</DialogTitle>
            <DialogDescription>Admin-only status correction. RISK_MANAGER cannot persist this change.</DialogDescription>
          </DialogHeader>
          <select
            value={overrideStatus}
            onChange={(event) => setOverrideStatus(event.target.value as AccountStatus)}
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
          >
            {['ACTIVE', 'PASSED_PHASE_1', 'PASSED_PHASE_2', 'FUNDED', 'BREACHED_DAILY', 'BREACHED_MAX'].map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="min-h-20 rounded-md border border-border bg-background p-2 text-sm"
          />
          <DialogFooter>
            <Button
              disabled={user.role !== 'ADMIN'}
              onClick={async () => {
                if (!selected) return
                try {
                  await api(`/api/admin/accounts/${selected.id}/override`, {
                    method: 'POST',
                    body: JSON.stringify({ status: overrideStatus, reason }),
                  })
                  setOverrideOpen(false)
                  await load()
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Override failed')
                }
              }}
            >
              Save override
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminDeskFrame>
  )
}
