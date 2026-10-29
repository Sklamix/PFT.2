'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { LogOut, ReceiptText, Search, UserPlus, Wallet } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { AdminDeskFrame } from '@/components/admin/admin-desk-frame'
import { ActionReviews } from '@/components/admin/action-reviews'
import { AbusePanel } from '@/components/admin/abuse-panel'
import { AppealQueue, type AppealItem } from '@/components/admin/appeal-queue'
import { OverrideApprovals } from '@/components/admin/override-approvals'
import { ReadinessPanel, type ReadinessSummary } from '@/components/admin/readiness-panel'
import { CreateStaffDialog } from '@/components/admin/staff-dialog'
import { KpiBar } from '@/components/admin/kpi-bar'
import { KycDialog } from '@/components/admin/kyc-dialog'
import { OrdersQueue } from '@/components/admin/orders-queue'
import { PayoutQueue } from '@/components/admin/payout-queue'
import { PayoutsManagement } from '@/components/admin/payouts-management'
import { RiskTable } from '@/components/admin/risk-table'
import { StaffMessages } from '@/components/admin/staff-messages'
import { ActivityLog } from '@/components/admin/activity-log'
import { TradingConditionsManagement } from '@/components/admin/trading-conditions-management'
import { TelemetryController } from '@/components/admin/telemetry-controller'
import { TradeHistoryModal } from '@/components/admin/trade-history-modal'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type {
  AccountStatus,
  AbuseOverview,
  AdminSession,
  OverviewMetrics,
  OrderRow,
  PayoutRow,
  PendingAccountOverride,
  PendingActionReview,
  TelemetryState,
  TradeRow,
  TraderFilter,
  TraderRow,
} from '@/lib/admin/types'

const FILTERS: { id: TraderFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'evaluation', label: 'Evaluation' },
  { id: 'funded', label: 'Funded' },
  { id: 'near_limit', label: 'Near Limit (Alerts)' },
  { id: 'breached', label: 'Breached' },
  { id: 'passing', label: 'Active - Passing' },
]

/** Sections of the admin desk, rendered one at a time to keep the panel uncluttered. */
const SECTIONS = [
  { id: 'monitor', label: 'Risk Monitor' },
  { id: 'reviews', label: 'Reviews & Approvals' },
  { id: 'operations', label: 'Operations' },
  { id: 'messages', label: 'Messages' },
  { id: 'activity', label: 'Activity log' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

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
  const [traderId, setTraderId] = useState('all')
  const [metrics, setMetrics] = useState<OverviewMetrics | null>(null)
  const [rows, setRows] = useState<TraderRow[]>([])
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [payouts, setPayouts] = useState<PayoutRow[]>([])
  const [overrideApprovals, setOverrideApprovals] = useState<PendingAccountOverride[]>([])
  const [actionReviews, setActionReviews] = useState<PendingActionReview[]>([])
  const [readiness, setReadiness] = useState<ReadinessSummary | null>(null)
  const [abuse, setAbuse] = useState<AbuseOverview | null>(null)
  const [appeals, setAppeals] = useState<AppealItem[]>([])
  const [telemetry, setTelemetry] = useState<TelemetryState | null>(null)
  const [queueOpen, setQueueOpen] = useState(false)
  const [ordersOpen, setOrdersOpen] = useState(false)
  const [selected, setSelected] = useState<TraderRow | null>(null)
  const [trades, setTrades] = useState<TradeRow[]>([])
  const [tradesOpen, setTradesOpen] = useState(false)
  const [payoutHold, setPayoutHold] = useState<{ active: boolean; reason: string | null } | null>(null)
  const [breachOpen, setBreachOpen] = useState(false)
  const [kycOpen, setKycOpen] = useState(false)
  const [kycUserId, setKycUserId] = useState<string | null>(null)
  const [overrideOpen, setOverrideOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [overrideStatus, setOverrideStatus] = useState<AccountStatus>('ACTIVE')
  const [error, setError] = useState<string | null>(null)
  const [breachType, setBreachType] = useState<'BREACHED_DAILY' | 'BREACHED_MAX'>('BREACHED_DAILY')
  const [staffOpen, setStaffOpen] = useState(false)
  const [grantOpen, setGrantOpen] = useState(false)
  const [grantBusy, setGrantBusy] = useState(false)
  const [grantPlanSize, setGrantPlanSize] = useState(10_000)
  const [grantType, setGrantType] = useState<'1-Step' | '2-Step'>('1-Step')
  const [grantAs, setGrantAs] = useState<'evaluation' | 'funded'>('evaluation')
  const [grantReason, setGrantReason] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteMode, setDeleteMode] = useState<'account' | 'trader'>('account')
  const [deleteReason, setDeleteReason] = useState('')
  const [deleteConfirmEmail, setDeleteConfirmEmail] = useState('')
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [section, setSection] = useState<SectionId>('monitor')

  const load = useCallback(async () => {
    try {
      const [overview, traders, queue, orderRows, pulse, approvals, reviews, readinessReport, appealItems, abuseReport] = await Promise.all([
        api<OverviewMetrics>('/api/admin/metrics/overview'),
        api<{ items: TraderRow[] }>(`/api/admin/traders?q=${encodeURIComponent(query)}&filter=${filter}`),
        api<{ items: PayoutRow[] }>('/api/admin/payouts'),
        api<{ items: OrderRow[] }>('/api/admin/orders'),
        api<TelemetryState>('/api/admin/telemetry'),
        user.role === 'ADMIN'
          ? api<{ items: PendingAccountOverride[] }>('/api/admin/funding-approvals')
          : Promise.resolve({ items: [] as PendingAccountOverride[] }),
        user.role === 'ADMIN'
          ? api<{ items: PendingActionReview[] }>('/api/admin/action-reviews')
          : Promise.resolve({ items: [] as PendingActionReview[] }),
        user.role === 'ADMIN'
          ? api<ReadinessSummary>('/api/admin/readiness')
          : Promise.resolve(null),
        user.role === 'ADMIN'
          ? api<{ items: AppealItem[] }>('/api/admin/appeals')
          : Promise.resolve({ items: [] as AppealItem[] }),
        user.role === 'ADMIN'
          ? api<AbuseOverview>('/api/admin/abuse')
          : Promise.resolve(null),
      ])
      setMetrics(overview)
      setRows(traders.items)
      setPayouts(queue.items)
      setOrders(orderRows.items)
      setTelemetry(pulse)
      setOverrideApprovals(approvals.items)
      setActionReviews(reviews.items)
      setReadiness(readinessReport)
      setAppeals(appealItems.items)
      setAbuse(abuseReport)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load operations desk')
    }
  }, [filter, query, user.role])

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

  const reloadTrades = async () => {
    if (!selected) return
    const data = await api<{ trades: TradeRow[] }>(`/api/admin/accounts/${selected.id}/trades`)
    setTrades(data.trades)
  }

  const holdPayouts = async () => {
    if (!selected) return
    const reason = window.prompt('Reason for payout hold:')
    if (!reason?.trim()) return
    try {
      const data = await api<{ hold: { active: boolean; reason: string | null } }>(
        `/api/admin/accounts/${selected.id}/payout-hold`,
        { method: 'POST', body: JSON.stringify({ action: 'hold', reason: reason.trim() }) },
      )
      setPayoutHold(data.hold)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to hold payouts')
    }
  }

  const clearPayoutHold = async () => {
    if (!selected) return
    const reason = window.prompt('Reason for clearing payout hold:')
    if (!reason?.trim()) return
    try {
      const data = await api<{ hold: { active: boolean; reason: string | null } }>(
        `/api/admin/accounts/${selected.id}/payout-hold`,
        { method: 'POST', body: JSON.stringify({ action: 'clear', reason: reason.trim() }) },
      )
      setPayoutHold(data.hold)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to clear payout hold')
    }
  }

  const toggleRiskFlag = async (row: TraderRow) => {
    const action = row.riskFlagged ? 'clear' : 'flag'
    const reason = window.prompt(
      action === 'flag'
        ? `Open a risk review on ${row.traderEmail}? New purchases and payouts pause until it is cleared. Reason:`
        : `Clear the risk review on ${row.traderEmail}? Reason:`,
    )
    if (!reason?.trim()) return
    try {
      await api(`/api/admin/users/${row.userId}/risk-flag`, {
        method: 'POST',
        body: JSON.stringify({ action, reason: reason.trim() }),
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update the risk flag')
    }
  }

  const voidTrade = async (trade: TradeRow) => {
    const reason = window.prompt(`Void ${trade.symbol} trade? Reason:`)
    if (!reason?.trim()) return
    try {
      await api(`/api/admin/trades/${trade.id}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      })
      await reloadTrades()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to void trade')
    }
  }

  const decideOverride = async (item: PendingAccountOverride, action: 'approve' | 'reject') => {
    const verb = action === 'approve' ? 'Approve override for' : 'Reject override for'
    const reason = window.prompt(`${verb} ${item.displayId}? Reason:`)
    if (!reason?.trim()) return
    try {
      await api(`/api/admin/accounts/${item.accountId}/override-approval`, {
        method: 'POST',
        body: JSON.stringify({
          requestId: item.requestId,
          reason: reason.trim(),
          ...(action === 'reject' ? { action: 'reject' } : {}),
        }),
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : `Unable to ${action} override request`)
    }
  }

  const decideActionReview = async (item: PendingActionReview, decision: 'confirm' | 'flag') => {
    const verb = decision === 'confirm' ? 'Confirm' : 'Flag'
    const note = window.prompt(
      `${verb} ${item.kind === 'BREACH' ? 'kill-switch' : 'reset'} on ${item.displayId}? Review note:`,
    )
    if (!note?.trim()) return
    try {
      await api(`/api/admin/accounts/${item.accountId}/action-review`, {
        method: 'POST',
        body: JSON.stringify({ requestId: item.requestId, decision, note: note.trim() }),
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : `Unable to ${decision} action review`)
    }
  }

  const decideAppeal = async (item: AppealItem, decision: 'uphold' | 'overturn') => {
    const verb = decision === 'overturn' ? 'Overturn' : 'Uphold'
    const note = window.prompt(`${verb} the appeal for ${item.displayId}? Decision note:`)
    if (!note?.trim()) return
    try {
      await api(`/api/admin/accounts/${item.accountId}/appeal`, {
        method: 'POST',
        body: JSON.stringify({ appealId: item.id, decision, note: note.trim() }),
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : `Unable to ${decision} appeal`)
    }
  }

  // Distinct traders across the loaded account rows, for the per-trader filter.
  const traders = (() => {
    const map = new Map<string, { userId: string; label: string; count: number }>()
    for (const row of rows) {
      const existing = map.get(row.userId)
      if (existing) existing.count += 1
      else
        map.set(row.userId, {
          userId: row.userId,
          label: `${row.traderName || row.traderEmail} (${row.traderEmail})`,
          count: 1,
        })
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label))
  })()

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
          {user.role === 'ADMIN' && (
            <Button variant="outline" size="sm" onClick={() => setStaffOpen(true)}>
              <UserPlus />
              Add staff
            </Button>
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

      {/* Section tabs */}
      <nav className="flex flex-wrap items-center gap-1 border-b border-border pb-2" aria-label="Admin sections">
        {SECTIONS.map((item) => (
          <Button
            key={item.id}
            size="sm"
            variant={section === item.id ? 'default' : 'ghost'}
            onClick={() => setSection(item.id)}
          >
            {item.label}
            {item.id === 'reviews' && actionReviews.length + overrideApprovals.length + appeals.length > 0
              ? ` (${actionReviews.length + overrideApprovals.length + appeals.length})`
              : ''}
          </Button>
        ))}
      </nav>

      {section === 'monitor' ? (
        <>
          <ReadinessPanel report={readiness} />
          <AbusePanel report={abuse} />

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
                placeholder="Search account, trading login, email"
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
              <select
                value={traderId}
                onChange={(event) => setTraderId(event.target.value)}
                className="h-6 rounded-md border border-border bg-background px-2 text-xs"
                aria-label="Filter by trader"
              >
                <option value="all">All traders</option>
                {traders.map((trader) => (
                  <option key={trader.userId} value={trader.userId}>
                    {trader.label} — {trader.count} {trader.count === 1 ? 'account' : 'accounts'}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

          <RiskTable
          rows={traderId === 'all' ? rows : rows.filter((row) => row.userId === traderId)}
          onTrades={async (row) => {
            try {
              const [data, hold] = await Promise.all([
                api<{ trades: TradeRow[] }>(`/api/admin/accounts/${row.id}/trades`),
                api<{ hold: { active: boolean; reason: string | null } }>(`/api/admin/accounts/${row.id}/payout-hold`),
              ])
              setSelected(row)
              setTrades(data.trades)
              setPayoutHold(hold.hold)
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
            setReason('')
            setOverrideOpen(true)
          }}
          onRiskFlag={(row) => void toggleRiskFlag(row)}
          onGrantAccount={(row) => {
            setSelected(row)
            setGrantReason(`Granted to ${row.traderEmail}`)
            setGrantOpen(true)
          }}
          onDelete={(row) => {
            setSelected(row)
            setDeleteMode('account')
            setDeleteReason('')
            setDeleteConfirmEmail('')
            setNotice(null)
            setDeleteOpen(true)
          }}
        />
          </section>
        </>
      ) : null}

      {section === 'reviews' ? (
        <>
          <ActionReviews
            items={actionReviews}
            onConfirm={(item) => void decideActionReview(item, 'confirm')}
            onFlag={(item) => void decideActionReview(item, 'flag')}
          />
          <AppealQueue
            items={appeals}
            onUphold={(item) => void decideAppeal(item, 'uphold')}
            onOverturn={(item) => void decideAppeal(item, 'overturn')}
          />
          <OverrideApprovals
            items={overrideApprovals}
            onApprove={(item) => void decideOverride(item, 'approve')}
            onReject={(item) => void decideOverride(item, 'reject')}
          />
        </>
      ) : null}

      {section === 'operations' ? (
        <>
          <TelemetryController state={telemetry} />
          <PayoutsManagement canManage={user.role === 'ADMIN'} />
          <TradingConditionsManagement canManage={user.role === 'ADMIN'} />
        </>
      ) : null}

      {section === 'messages' ? <StaffMessages /> : null}
      {section === 'activity' ? <ActivityLog role={user.role} /> : null}

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

      <TradeHistoryModal
        open={tradesOpen}
        onOpenChange={setTradesOpen}
        account={selected}
        trades={trades}
        payoutHold={payoutHold}
        onHold={holdPayouts}
        onClearHold={clearPayoutHold}
        onVoid={voidTrade}
      />

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

      <CreateStaffDialog open={staffOpen} onOpenChange={setStaffOpen} onCreated={() => void load()} />

      <Dialog open={grantOpen} onOpenChange={setGrantOpen}>
        <DialogContent className="border-border bg-card sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Grant account to {selected?.traderName ?? 'trader'}</DialogTitle>
            <DialogDescription>
              Creates a new account of any type instantly. Minor action — audited, but no second-admin approval is
              required.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">Plan size</span>
              <select
                value={grantPlanSize}
                onChange={(event) => setGrantPlanSize(Number(event.target.value))}
                className="h-8 rounded-md border border-border bg-background px-2 font-mono text-sm"
              >
                {[1_000, 3_000, 5_000, 10_000, 25_000, 50_000, 100_000, 200_000].map((size) => (
                  <option key={size} value={size}>
                    ${size.toLocaleString('en-US')}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-2">
              {(['1-Step', '2-Step'] as const).map((type) => (
                <Button key={type} size="xs" variant={grantType === type ? 'default' : 'outline'} onClick={() => setGrantType(type)}>
                  {type}
                </Button>
              ))}
              {(['evaluation', 'funded'] as const).map((mode) => (
                <Button key={mode} size="xs" variant={grantAs === mode ? 'default' : 'outline'} onClick={() => setGrantAs(mode)}>
                  {mode === 'evaluation' ? 'Evaluation' : 'Funded'}
                </Button>
              ))}
            </div>
            <input
              value={grantReason}
              onChange={(event) => setGrantReason(event.target.value)}
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
              placeholder="Audit reason (e.g. sponsorship, support credit)"
            />
          </div>
          <DialogFooter>
            <Button
              disabled={grantBusy || grantReason.trim().length < 4}
              onClick={async () => {
                if (!selected) return
                setGrantBusy(true)
                try {
                  await api(`/api/admin/users/${selected.userId}/grant-account`, {
                    method: 'POST',
                    body: JSON.stringify({
                      planSize: grantPlanSize,
                      challengeType: grantType,
                      grantAs,
                      reason: grantReason,
                    }),
                  })
                  setGrantOpen(false)
                  setGrantBusy(false)
                  await load()
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Grant failed')
                  setGrantBusy(false)
                }
              }}
            >
              {grantBusy ? 'Granting…' : 'Grant account'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="border-border bg-card sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {deleteMode === 'account' ? `account ${selected?.displayId ?? ''}` : `trader ${selected?.traderEmail ?? ''}`}</DialogTitle>
            <DialogDescription>
              Deletion is permanent. Trades, positions, orders and payouts belonging to the
              {deleteMode === 'account' ? ' account' : ' trader'} are removed with it. Certificates are detached from the
              deleted account but stay verifiable.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <div className="flex gap-2">
              <Button
                size="xs"
                variant={deleteMode === 'account' ? 'default' : 'outline'}
                onClick={() => setDeleteMode('account')}
              >
                This account only
              </Button>
              <Button
                size="xs"
                variant={deleteMode === 'trader' ? 'destructive' : 'outline'}
                onClick={() => setDeleteMode('trader')}
              >
                Entire trader
              </Button>
            </div>

            {deleteMode === 'trader' ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-[11px] leading-relaxed text-destructive">
                This removes the trader login and every account, order, payout and certificate on the account. The action
                is recorded in the audit log and cannot be undone.
              </div>
            ) : null}

            <textarea
              value={deleteReason}
              onChange={(event) => setDeleteReason(event.target.value)}
              className="min-h-20 rounded-md border border-border bg-background p-2 text-sm"
              placeholder={
                deleteMode === 'account'
                  ? 'Reason (min. 4 characters), e.g. duplicate test account'
                  : 'Reason (min. 10 characters), e.g. fraudulent signup / duplicate record'
              }
            />

            {deleteMode === 'trader' ? (
              <label className="grid gap-1 text-sm">
                <span className="text-muted-foreground">
                  Type <span className="font-mono text-foreground">{selected?.traderEmail}</span> to confirm
                </span>
                <input
                  value={deleteConfirmEmail}
                  onChange={(event) => setDeleteConfirmEmail(event.target.value)}
                  className="h-9 rounded-md border border-border bg-background px-2 font-mono text-sm"
                  autoComplete="off"
                />
              </label>
            ) : null}

            {notice ? <p className="text-xs text-destructive">{notice}</p> : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleteBusy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={
                deleteBusy ||
                deleteReason.trim().length < (deleteMode === 'account' ? 4 : 10) ||
                (deleteMode === 'trader' && deleteConfirmEmail.trim().toLowerCase() !== (selected?.traderEmail ?? '').toLowerCase())
              }
              onClick={async () => {
                if (!selected) return
                setDeleteBusy(true)
                setNotice(null)
                try {
                  if (deleteMode === 'account') {
                    await api(`/api/admin/accounts/${selected.id}`, {
                      method: 'DELETE',
                      body: JSON.stringify({ reason: deleteReason }),
                    })
                  } else {
                    await api(`/api/admin/users/${selected.userId}`, {
                      method: 'DELETE',
                      body: JSON.stringify({ reason: deleteReason, confirmEmail: deleteConfirmEmail }),
                    })
                  }
                  setDeleteOpen(false)
                  setDeleteBusy(false)
                  await load()
                } catch (err) {
                  setNotice(err instanceof Error ? err.message : 'Delete failed')
                  setDeleteBusy(false)
                }
              }}
            >
              {deleteBusy ? 'Deleting…' : deleteMode === 'account' ? 'Delete account' : 'Delete trader'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={overrideOpen} onOpenChange={setOverrideOpen}>        <DialogContent className="border-border bg-card sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Override {selected?.displayId}</DialogTitle>
            <DialogDescription>
              Every status change needs a reason and a second admin. The account stays unchanged until another admin
              approves the request. RISK_MANAGER cannot persist this change.
            </DialogDescription>
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
            placeholder="Why is this status change needed?"
          />
          <DialogFooter>
            <Button
              disabled={user.role !== 'ADMIN' || !reason.trim()}
              onClick={async () => {
                if (!selected) return
                try {
                  const result = await api<{ approvalRequired?: boolean; requestId?: string; reused?: boolean }>(
                    `/api/admin/accounts/${selected.id}/override`,
                    {
                      method: 'POST',
                      body: JSON.stringify({ status: overrideStatus, reason }),
                    },
                  )
                  if (result.approvalRequired) {
                    window.alert(
                      result.reused
                        ? `An override to ${overrideStatus} is already awaiting a second admin (request ${result.requestId}).`
                        : `Override to ${overrideStatus} requested. A different admin must approve request ${result.requestId}.`,
                    )
                  }
                  setOverrideOpen(false)
                  await load()
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Override failed')
                }
              }}
            >
              Request override
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminDeskFrame>
  )
}
