'use client'

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, Inbox, Loader2, RefreshCw, Send, ShieldAlert, UserCheck, UserMinus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SupportAgentPanel } from '@/components/admin/support-agent-panel'
import { MessageBody } from '@/components/support/chat/message-body'
import { TypingDots } from '@/components/support/chat/typing-dots'
import { useFillHeight } from '@/hooks/use-fill-height'
import { useSupportPoll } from '@/hooks/use-support-poll'
import { mergeMessages, latestCreatedAt } from '@/lib/support/live'
import { readBrief } from '@/lib/support/brief'
import { cn } from '@/lib/utils'

const CATEGORIES = ['GENERAL', 'CHALLENGE', 'PAYOUT', 'KYC', 'ACCOUNT', 'TECHNICAL', 'RULES'] as const
const STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_USER', 'WAITING_FOR_STAFF', 'RESOLVED', 'CLOSED'] as const
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const

type Status = (typeof STATUSES)[number]
type Priority = (typeof PRIORITIES)[number]
type Category = (typeof CATEGORIES)[number]

type StaffTicket = {
  publicId: string
  subject: string
  category: Category
  status: Status
  priority: Priority
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
  closedAt: string | null
  messageCount: number
  trader: { name: string; email: string }
  assignedTo: { id: string; name: string; email: string } | null
}

type StaffTicketDetail = {
  ticket: StaffTicket & { trader: { name: string; email: string; kycStatus: string } }
  messages: {
    items: { id: string; senderType: 'TRADER' | 'STAFF' | 'AI'; body: string; createdAt: string; senderName: string | null; senderEmail: string | null; metadata: unknown }[]
    page: number
    pageSize: number
    total: number
  }
}

type EscalatedItem = {
  escalation: { publicId: string; requestedAction: string; reason: string; raisedAt: string }
  ticket: { publicId: string; subject: string; category: string; status: string; priority: string; trader: { name: string; email: string } } | null
}

type SupportMetrics = {
  openTickets: number
  waitingForStaff: number
  supportChatTickets24h: number
  asOf: string
}

const STATUS_LABEL: Record<Status, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  WAITING_FOR_USER: 'Waiting for trader',
  WAITING_FOR_STAFF: 'Waiting for staff',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
}

const STATUS_STYLE: Record<Status, string> = {
  OPEN: 'border-primary/30 bg-primary/10 text-primary',
  IN_PROGRESS: 'border-highlight/30 bg-highlight/10 text-highlight',
  WAITING_FOR_USER: 'border-warning/30 bg-warning/10 text-warning',
  WAITING_FOR_STAFF: 'border-border bg-secondary text-foreground',
  RESOLVED: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  CLOSED: 'border-border bg-secondary/60 text-muted-foreground',
}

const PRIORITY_STYLE: Record<Priority, string> = {
  LOW: 'text-muted-foreground',
  NORMAL: 'text-foreground',
  HIGH: 'text-warning',
  URGENT: 'text-danger',
}

const PAGE_SIZE = 20
const MESSAGE_PAGE_SIZE = 50

function formatDate(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatTime(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

async function api<T>(url: string, init?: RequestInit): Promise<{ status: number; data: T | { error?: string } }> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    cache: 'no-store',
  })
  return { status: response.status, data: await response.json().catch(() => ({})) }
}

function errorText(status: number, payload: { error?: string }) {
  if (status === 401) return 'Session expired — sign in again.'
  if (status === 403) return payload.error ?? 'Your role cannot perform this action.'
  if (status === 404) return 'Ticket not found.'
  if (status === 409) return payload.error ?? 'Invalid status transition.'
  if (status === 429) return payload.error ?? 'Too many requests.'
  return payload.error ?? 'Request failed. Please retry.'
}

export function SupportDesk({ role, userId }: { role: string; userId: string }) {
  const canWrite = role === 'ADMIN' || role === 'SUPPORT'

  const [metrics, setMetrics] = useState<SupportMetrics | null>(null)
  const [metricsError, setMetricsError] = useState<string | null>(null)
  const [tickets, setTickets] = useState<StaffTicket[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState<'' | Status>('')
  const [priority, setPriority] = useState<'' | Priority>('')
  const [category, setCategory] = useState<'' | Category>('')
  const [assignee, setAssignee] = useState<'' | 'me' | 'unassigned'>('')
  const [sort, setSort] = useState<'updated' | 'priority'>('updated')
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<StaffTicketDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)

  const [escalatedOnly, setEscalatedOnly] = useState(false)
  const [escalated, setEscalated] = useState<EscalatedItem[] | null>(null)
  const [escalatedError, setEscalatedError] = useState<string | null>(null)

  const { ref: fillRef, style: fillStyle } = useFillHeight<HTMLDivElement>()
  const selectedTicketSinceRef = useRef<string | null>(null)

  // Poll the open ticket for new messages every 3s.
  useSupportPoll({
    getUrl: () => (selectedId ? `/api/admin/support/tickets/${encodeURIComponent(selectedId)}?pageSize=50` : null),
    enabled: !!selectedId,
    intervalMs: 3_000,
    onData: (data: unknown) => {
      const record = data as { messages?: { items?: StaffTicketDetail['messages']['items'] } } | null
      if (!record?.messages?.items) return
      const incoming = record.messages.items
      setDetail((current) => {
        if (!current) return null
        const merged = mergeMessages(current.messages.items, incoming)
        selectedTicketSinceRef.current = latestCreatedAt(merged)
        return { ...current, messages: { ...current.messages, items: merged } }
      })
    },
  })

  const loadEscalations = useCallback(
    async () => {
      setLoading(true)
      setEscalatedError(null)
      try {
        const { status: code, data } = await api<{ items: EscalatedItem[] }>('/api/admin/support/escalations')
        if (code !== 200 || !('items' in data)) {
          setEscalatedError(errorText(code, data as { error?: string }))
          return
        }
        setEscalated(data.items)
      } catch {
        setEscalatedError('Network error. Retry to load the escalations.')
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    if (escalatedOnly) void loadEscalations()
  }, [escalatedOnly, loadEscalations])

  const loadList = useCallback(
    async (nextPage: number) => {
      setLoading(true)
      setListError(null)
      try {
        const params = new URLSearchParams({ page: String(nextPage), pageSize: String(PAGE_SIZE), sort })
        if (status) params.set('status', status)
        if (priority) params.set('priority', priority)
        if (category) params.set('category', category)
        if (assignee) params.set('assignedTo', assignee)
        const { status: code, data } = await api<{ items: StaffTicket[]; total: number; page: number }>(`/api/admin/support/tickets?${params}`)
        if (code === 401) {
          window.location.assign('/admin/login')
          return
        }
        if (code !== 200 || !('items' in data)) {
          setListError(errorText(code, data as { error?: string }))
          return
        }
        setTickets(data.items)
        setTotal(data.total)
        setPage(data.page)
      } catch {
        setListError('Network error. Retry to reload the queue.')
      } finally {
        setLoading(false)
      }
    },
    [assignee, category, priority, sort, status],
  )

  useEffect(() => {
    void loadList(1)
  }, [loadList])

  useEffect(() => {
    if (role !== 'ADMIN') return
    let cancelled = false
    const loadMetrics = async () => {
      try {
        const { status: code, data } = await api<SupportMetrics>('/api/admin/support/metrics')
        if (code !== 200 || !('openTickets' in data)) {
          throw new Error(errorText(code, data as { error?: string }))
        }
        if (!cancelled) {
          setMetrics(data)
          setMetricsError(null)
        }
      } catch (error) {
        if (!cancelled) setMetricsError(error instanceof Error ? error.message : 'Unable to load support metrics.')
      }
    }
    void loadMetrics()
    const timer = window.setInterval(() => void loadMetrics(), 20_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [role])

  const loadDetail = useCallback(async (publicId: string, messagePage = 1) => {
    setDetailLoading(true)
    setDetailError(null)
    try {
      const params = new URLSearchParams({ page: String(messagePage), pageSize: String(MESSAGE_PAGE_SIZE) })
      const { status: code, data } = await api<StaffTicketDetail>(`/api/admin/support/tickets/${encodeURIComponent(publicId)}?${params}`)
      if (code !== 200 || !('ticket' in data)) {
        setDetailError(errorText(code, data as { error?: string }))
        setDetail(null)
        return
      }
      selectedTicketSinceRef.current = latestCreatedAt(data.messages.items)
      setDetail(data)
    } catch {
      setDetailError('Network error while loading the ticket.')
    } finally {
      setDetailLoading(false)
    }
  }, [])

  function openTicket(publicId: string) {
    setSelectedId(publicId)
    setDetail(null)
    setDraft('')
    setActionError(null)
    setNotice(null)
    selectedTicketSinceRef.current = null
    void loadDetail(publicId)
  }

  async function patchTicket(payload: Record<string, unknown>, label: string) {
    if (!selectedId || busyAction) return
    setBusyAction(label)
    setActionError(null)
    try {
      const { status: code, data } = await api(`/api/admin/support/tickets/${encodeURIComponent(selectedId)}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
      if (code !== 200) {
        setActionError(errorText(code, data as { error?: string }))
        return
      }
      setNotice(`${label} updated`)
      await Promise.all([loadDetail(selectedId), loadList(page)])
    } catch {
      setActionError('Network error. The change was not saved.')
    } finally {
      setBusyAction(null)
    }
  }

  async function sendReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedId || sending || draft.trim().length === 0) return
    setSending(true)
    setActionError(null)
    try {
      const { status: code, data } = await api(`/api/admin/support/tickets/${encodeURIComponent(selectedId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body: draft, idempotencyKey: crypto.randomUUID() }),
      })
      if (code !== 200 && code !== 201) {
        setActionError(errorText(code, data as { error?: string }))
        return
      }
      setDraft('')
      setNotice('Reply sent')
      await Promise.all([loadDetail(selectedId), loadList(page)])
    } catch {
      setActionError('Network error. The reply was not sent.')
    } finally {
      setSending(false)
    }
  }

  const active = detail?.ticket ?? tickets.find((ticket) => ticket.publicId === selectedId) ?? null
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const messagePages = detail ? Math.max(1, Math.ceil(detail.messages.total / detail.messages.pageSize)) : 1

  return (
    <div className="flex flex-col gap-3">
      {role === 'ADMIN' ? (
        metrics ? (
          <div className="grid gap-2 sm:grid-cols-3" aria-label="Support queue metrics">
            {[
              { label: 'Open tickets', value: metrics.openTickets },
              { label: 'Waiting for staff', value: metrics.waitingForStaff },
              { label: 'Support chat tickets · 24h', value: metrics.supportChatTickets24h },
            ].map((item) => (
              <div key={item.label} className="rounded-xl border border-border bg-card px-3 py-2">
                <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{item.label}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{item.value}</p>
              </div>
            ))}
          </div>
        ) : metricsError ? (
          <p role="status" className="text-xs text-muted-foreground">{metricsError}</p>
        ) : null
      ) : null}
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-3">
        <Filter label="Status" value={status} onChange={(value) => setStatus(value as '' | Status)} options={STATUSES} labels={STATUS_LABEL} />
        <Filter label="Priority" value={priority} onChange={(value) => setPriority(value as '' | Priority)} options={PRIORITIES} />
        <Filter label="Category" value={category} onChange={(value) => setCategory(value as '' | Category)} options={CATEGORIES} />
        <Filter
          label="Assignee"
          value={assignee}
          onChange={(value) => setAssignee(value as '' | 'me' | 'unassigned')}
          options={['me', 'unassigned'] as const}
          labels={{ me: 'Assigned to me', unassigned: 'Unassigned' }}
        />
        <Filter label="Sort" value={sort} onChange={(value) => setSort(value as 'updated' | 'priority')} options={['updated', 'priority'] as const} labels={{ updated: 'Last update', priority: 'Priority' }} />
        <Button
          variant={escalatedOnly ? 'default' : 'outline'}
          size="sm"
          className="h-8 gap-1.5"
          aria-pressed={escalatedOnly}
          onClick={() => setEscalatedOnly((value) => !value)}
        >
          <ShieldAlert className="size-3.5" />
          Escalated
          {escalated && escalated.length > 0 ? <span className="font-mono text-[10px]">{escalated.length}</span> : null}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5"
          onClick={() => (escalatedOnly ? void loadEscalations() : void loadList(page))}
          disabled={loading}
        >
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          Refresh
        </Button>
        {!canWrite ? (
          <p className="ml-auto font-mono text-[10px] uppercase tracking-widest text-warning">Read-only role</p>
        ) : null}
      </div>

      <div ref={fillRef} style={fillStyle} className="grid min-h-0 gap-3 xl:grid-cols-[420px_minmax(0,1fr)_340px]">
        <section className={cn('flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card', selectedId ? 'hidden xl:flex' : 'block')}>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
            {escalatedOnly ? (
              loading ? (
                <p className="flex items-center gap-2 p-4 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading escalations…</p>
              ) : escalatedError ? (
                <div className="p-4 text-xs text-destructive">
                  <p>{escalatedError}</p>
                  <Button variant="outline" size="sm" className="mt-2" onClick={() => void loadEscalations()}>Retry</Button>
                </div>
              ) : escalated === null || escalated.length === 0 ? (
                <div className="p-8 text-center">
                  <ShieldAlert className="mx-auto size-5 text-muted-foreground" />
                  <p className="mt-2 text-xs text-muted-foreground">No active escalations.</p>
                </div>
              ) : (
                <ul className="divide-y divide-border/60">
                  {escalated.map((item) => (
                    <li key={item.escalation.publicId}>
                      <button
                        type="button"
                        onClick={() => item.ticket && openTicket(item.ticket.publicId)}
                        className={cn(
                          'w-full px-3 py-3 text-left transition-colors hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                          selectedId === item.escalation.publicId && 'bg-primary/10',
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{item.ticket?.subject ?? item.escalation.publicId}</span>
                          <span className="shrink-0 rounded-full border border-warning/30 bg-warning/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-warning">
                            {item.escalation.requestedAction}
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.escalation.reason}</p>
                        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/80">
                          {item.ticket ? `${item.ticket.trader.email} · ` : ''}raised {formatTime(item.escalation.raisedAt)}
                        </p>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : loading ? (
              <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading queue">
                {[1, 2, 3].map((n) => (
                  <div key={n} className="h-10 animate-skeleton rounded-lg border border-border bg-secondary/30" aria-hidden="true" />
                ))}
              </div>
            ) : listError ? (
              <div className="p-4 text-xs text-destructive">
                <p>{listError}</p>
                <Button variant="outline" size="sm" className="mt-2" onClick={() => void loadList(page)}>Retry</Button>
              </div>
            ) : tickets.length === 0 ? (
              <div className="p-8 text-center">
                <Inbox className="mx-auto size-5 text-muted-foreground" />
                <p className="mt-2 text-xs text-muted-foreground">No tickets match these filters.</p>
              </div>
            ) : (
              <ul className="divide-y divide-border/60">
                {tickets.map((ticket) => (
                  <li key={ticket.publicId}>
                    <button
                      type="button"
                      onClick={() => openTicket(ticket.publicId)}
                      className={cn(
                        'w-full px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                        selectedId === ticket.publicId ? 'bg-primary/10' : 'hover:bg-secondary/40',
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{ticket.subject}</span>
                        <span className={cn('shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide', STATUS_STYLE[ticket.status])}>
                          {STATUS_LABEL[ticket.status]}
                        </span>
                      </div>
                      <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                        {ticket.trader.email} · {ticket.category} · {ticket.messageCount} msg
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[10px] text-muted-foreground/80">
                        <span className={PRIORITY_STYLE[ticket.priority]}>{ticket.priority}</span>
                        <span>{ticket.assignedTo ? `→ ${ticket.assignedTo.name}` : 'unassigned'}</span>
                        <span>{formatTime(ticket.updatedAt)}</span>
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className={cn('flex items-center justify-between border-t border-border px-3 py-2 text-[10px] text-muted-foreground', escalatedOnly && 'hidden')}>
            <Button variant="ghost" size="xs" disabled={page <= 1 || loading} onClick={() => void loadList(page - 1)}>Previous</Button>
            <span className="font-mono">{total === 0 ? '0' : `${page} / ${totalPages}`}</span>
            <Button variant="ghost" size="xs" disabled={page >= totalPages || loading} onClick={() => void loadList(page + 1)}>Next</Button>
          </div>
        </section>

        <section className={cn('min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card', selectedId ? 'flex' : 'hidden xl:flex')}>
          {!selectedId ? (
            <div className="flex flex-1 flex-col items-center justify-center p-10 text-center">
              <Inbox className="size-6 text-muted-foreground" />
              <p className="mt-3 text-sm text-foreground">Select a ticket</p>
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">Conversation, trader context and controls appear here.</p>
            </div>
          ) : (
            <>
              <header className="flex flex-wrap items-start gap-2 border-b border-border px-3 py-2.5">
                <Button variant="ghost" size="icon-sm" className="xl:hidden" onClick={() => setSelectedId(null)} aria-label="Back to queue">
                  <ArrowLeft className="size-4" />
                </Button>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-foreground">{active?.subject ?? 'Ticket'}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[10px] text-muted-foreground">
                    <span>{active?.publicId}</span>
                    <span>{active ? formatDate(active.createdAt) : ''}</span>
                    {detail?.ticket ? <span>KYC {detail.ticket.trader.kycStatus}</span> : null}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                    {detail?.ticket ? `${detail.ticket.trader.name} · ${detail.ticket.trader.email}` : ''}
                  </p>
                </div>
                {active ? (
                  <span className={cn('shrink-0 rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide', STATUS_STYLE[active.status])}>
                    {STATUS_LABEL[active.status]}
                  </span>
                ) : null}
              </header>

              {canWrite ? (
                <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-3 py-2">
                  <label className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-muted-foreground">
                    Status
                    <select
                      value={detail?.ticket.status ?? ''}
                      disabled={!detail || busyAction !== null}
                      onChange={(event) => void patchTicket({ status: event.target.value }, 'Status')}
                      className="h-7 rounded-md border border-input bg-background/70 px-1.5 font-mono text-[11px] text-foreground outline-none focus-visible:border-ring"
                    >
                      {detail ? <option value={detail.ticket.status}>{STATUS_LABEL[detail.ticket.status]}</option> : null}
                      {STATUSES.filter((value) => value !== detail?.ticket.status).map((value) => (
                        <option key={value} value={value}>{STATUS_LABEL[value]}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-muted-foreground">
                    Priority
                    <select
                      value={detail?.ticket.priority ?? ''}
                      disabled={!detail || busyAction !== null}
                      onChange={(event) => void patchTicket({ priority: event.target.value }, 'Priority')}
                      className="h-7 rounded-md border border-input bg-background/70 px-1.5 font-mono text-[11px] text-foreground outline-none focus-visible:border-ring"
                    >
                      {detail ? <option value={detail.ticket.priority}>{detail.ticket.priority}</option> : null}
                      {PRIORITIES.filter((value) => value !== detail?.ticket.priority).map((value) => (
                        <option key={value} value={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-7 gap-1"
                    disabled={!detail || busyAction !== null}
                    onClick={() => void patchTicket({ assignedToId: userId }, 'Assignee')}
                  >
                    <UserCheck className="size-3.5" /> Assign to me
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="h-7 gap-1"
                    disabled={!detail || busyAction !== null || !detail.ticket.assignedTo}
                    onClick={() => void patchTicket({ assignedToId: null }, 'Assignee')}
                  >
                    <UserMinus className="size-3.5" /> Unassign
                  </Button>
                  {busyAction ? <span className="font-mono text-[10px] text-muted-foreground">{busyAction}…</span> : null}
                </div>
              ) : (
                <p className="border-b border-border/70 px-3 py-2 text-[11px] text-muted-foreground">
                  Risk managers can read support tickets but cannot reply or change them.
                </p>
              )}

              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
                {detailLoading && !detail ? (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading conversation…</p>
                ) : detailError ? (
                  <div className="text-xs text-destructive">
                    <p>{detailError}</p>
                    <Button variant="outline" size="sm" className="mt-2" onClick={() => selectedId && void loadDetail(selectedId)}>Retry</Button>
                  </div>
                ) : detail ? (
                  <>
                    {detail.messages.page > 1 ? (
                      <div className="mb-2 text-center">
                        <Button variant="ghost" size="xs" onClick={() => selectedId && void loadDetail(selectedId, detail.messages.page - 1)}>Load older</Button>
                      </div>
                    ) : null}
                    <ul className="flex flex-col gap-2.5">
                      {detail.messages.items.map((message) => {
                        const staff = message.senderType === 'STAFF'
                        return (
                          <li key={message.id} className={cn('flex', staff ? 'justify-end' : 'justify-start')}>
                            <div className={cn('max-w-[88%] rounded-xl border px-3 py-2', staff ? 'border-primary/25 bg-primary/10' : 'border-border bg-secondary/40')}>
                              <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
                                {staff ? `${message.senderName ?? 'Staff'} · PFT` : detail.ticket.trader.name}
                                {message.senderType === 'AI' ? ' · AI' : ''}
                              </p>
                              <MessageBody text={message.body} tone={staff ? 'staff' : message.senderType === 'AI' ? 'ai' : 'neutral'} />
                              <p className="mt-1 font-mono text-[9px] text-muted-foreground/80">{formatTime(message.createdAt)}</p>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                    {detail.messages.page < messagePages ? (
                      <div className="mt-2 text-center">
                        <Button variant="ghost" size="xs" onClick={() => selectedId && void loadDetail(selectedId, detail.messages.page + 1)}>Load newer</Button>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>

              <div className="border-t border-border p-3">
                {actionError ? <p role="alert" className="mb-2 text-xs text-destructive">{actionError}</p> : null}
                {notice ? <p role="status" className="mb-2 text-xs text-emerald-300">{notice}</p> : null}
                {canWrite ? (
                  <form onSubmit={(event) => void sendReply(event)} className="flex items-end gap-2">
                    <label className="min-w-0 flex-1">
                      <span className="sr-only">Reply</span>
                      <textarea
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        rows={2}
                        maxLength={5000}
                        placeholder={detail?.ticket.status === 'CLOSED' ? 'Reopen the ticket before replying.' : 'Reply to the trader…'}
                        disabled={sending || detail?.ticket.status === 'CLOSED'}
                        className="min-h-10 w-full resize-y rounded-md border border-input bg-background/70 px-2 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-60"
                      />
                    </label>
                    <Button type="submit" className="h-10 gap-1.5" disabled={sending || draft.trim().length === 0 || detail?.ticket.status === 'CLOSED'}>
                      {sending ? (
                        <>
                          <TypingDots />
                          <span className="hidden sm:inline">Sending…</span>
                        </>
                      ) : (
                        <>
                          <Send className="size-4" />
                          <span className="hidden sm:inline">Reply</span>
                        </>
                      )}
                    </Button>
                  </form>
                ) : null}
              </div>
            </>
          )}
        </section>

        <section
          className={cn(
            'min-w-0 min-h-0 self-start overflow-y-auto overscroll-contain rounded-xl border border-border bg-card',
            selectedId ? 'block' : 'hidden xl:block',
          )}
          aria-label="Support agent panel"
        >
          {selectedId ? (
            <SupportAgentPanel
              ticketId={selectedId}
              brief={readBrief(detail?.messages.items[0]?.metadata)}
              onInsertReply={(text) => setDraft((current) => (current.trim() ? current + '\n\n' + text : text))}
            />
          ) : (
            <div className="flex flex-col items-center justify-center p-10 text-center">
              <Inbox className="size-6 text-muted-foreground" />
              <p className="mt-3 text-sm text-foreground">Agent panel</p>
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">Snapshot, assist chat and history appear here when a ticket is open.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function Filter({
  label,
  value,
  onChange,
  options,
  labels,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: readonly string[]
  labels?: Record<string, string>
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 rounded-md border border-input bg-background/70 px-1.5 font-mono text-[11px] text-foreground outline-none focus-visible:border-ring"
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option} value={option}>{labels?.[option] ?? option}</option>
        ))}
      </select>
    </label>
  )
}
