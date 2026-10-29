'use client'

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, Inbox, Loader2, MessageSquarePlus, RefreshCw, Send, X } from 'lucide-react'
import { SpaceBackground } from '@/components/dashboard/space-background'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

const CATEGORIES = ['GENERAL', 'CHALLENGE', 'PAYOUT', 'KYC', 'ACCOUNT', 'TECHNICAL', 'RULES'] as const
const STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_USER', 'WAITING_FOR_STAFF', 'RESOLVED', 'CLOSED'] as const

type Category = (typeof CATEGORIES)[number]
type Status = (typeof STATUSES)[number]

type Ticket = {
  publicId: string
  subject: string
  category: Category
  status: Status
  priority: string
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
  closedAt: string | null
  messageCount: number
}

type Message = { id: string; senderType: 'TRADER' | 'STAFF' | 'AI'; body: string; createdAt: string }

type TicketDetail = {
  ticket: Ticket
  messages: { items: Message[]; page: number; pageSize: number; total: number }
}

const STATUS_LABEL: Record<Status, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  WAITING_FOR_USER: 'Waiting for you',
  WAITING_FOR_STAFF: 'Waiting for support',
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
  const data = await response.json().catch(() => ({}))
  return { status: response.status, data }
}

function errorMessage(status: number, payload: { error?: string }) {
  if (status === 401) return 'Your session expired. Please sign in again.'
  if (status === 403) return payload.error ?? 'You do not have access to this request.'
  if (status === 404) return 'This ticket could not be found.'
  if (status === 409) return payload.error ?? 'This ticket was changed. Refresh and try again.'
  if (status === 429) return payload.error ?? 'Too many requests. Please wait a moment.'
  return payload.error ?? 'Something went wrong. Please try again.'
}

export function TraderSupportView() {
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [listPage, setListPage] = useState(1)
  const [listTotal, setListTotal] = useState(0)
  const [statusFilter, setStatusFilter] = useState<'' | Status>('')
  const [loadingList, setLoadingList] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<TicketDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [messagePage, setMessagePage] = useState(1)

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const pendingKey = useRef<string | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [newSubject, setNewSubject] = useState('')
  const [newCategory, setNewCategory] = useState<Category>('GENERAL')
  const [newBody, setNewBody] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const loadTickets = useCallback(
    async (page: number, status: '' | Status) => {
      setLoadingList(true)
      setListError(null)
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
        if (status) params.set('status', status)
        const { status: code, data } = await api<{ items: Ticket[]; total: number; page: number }>(`/api/support/tickets?${params}`)
        if (code === 401) {
          window.location.assign('/auth/login?next=/dashboard/support')
          return
        }
        if (code !== 200 || !('items' in data)) {
          setListError(errorMessage(code, data as { error?: string }))
          return
        }
        setTickets(data.items)
        setListTotal(data.total)
        setListPage(data.page)
      } catch {
        setListError('Network error. Please check your connection and retry.')
      } finally {
        setLoadingList(false)
      }
    },
    [],
  )

  const loadDetail = useCallback(async (publicId: string, page: number) => {
    setDetailLoading(true)
    setDetailError(null)
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(MESSAGE_PAGE_SIZE) })
      const { status: code, data } = await api<TicketDetail>(`/api/support/tickets/${encodeURIComponent(publicId)}?${params}`)
      if (code === 401) {
        window.location.assign('/auth/login?next=/dashboard/support')
        return
      }
      if (code !== 200 || !('ticket' in data)) {
        setDetailError(errorMessage(code, data as { error?: string }))
        setDetail(null)
        return
      }
      setDetail(data)
      setMessagePage(data.messages.page)
    } catch {
      setDetailError('Network error. Please retry.')
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadTickets(1, statusFilter)
  }, [loadTickets, statusFilter])

  const openTicket = useCallback(
    (publicId: string) => {
      setSelectedId(publicId)
      setDetail(null)
      setDraft('')
      setSendError(null)
      pendingKey.current = null
      void loadDetail(publicId, 1)
    },
    [loadDetail],
  )

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedId || !detail || sending) return
    const body = draft.trim()
    if (!body) return
    if (!pendingKey.current) pendingKey.current = crypto.randomUUID()
    setSending(true)
    setSendError(null)
    try {
      const { status: code, data } = await api<{ message: Message; duplicate: boolean }>(
        `/api/support/tickets/${encodeURIComponent(selectedId)}/messages`,
        { method: 'POST', body: JSON.stringify({ body, idempotencyKey: pendingKey.current }) },
      )
      if (code !== 200 && code !== 201) {
        setSendError(errorMessage(code, data as { error?: string }))
        return
      }
      pendingKey.current = null
      setDraft('')
      await Promise.all([loadDetail(selectedId, messagePage), loadTickets(listPage, statusFilter)])
    } catch {
      // Keep the idempotency key so a retry cannot duplicate the message.
      setSendError('Network error — press send again; the message will not be duplicated.')
    } finally {
      setSending(false)
    }
  }

  async function createTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (creating) return
    setCreating(true)
    setCreateError(null)
    try {
      const { status: code, data } = await api<{ ticket: Ticket }>('/api/support/tickets', {
        method: 'POST',
        body: JSON.stringify({ subject: newSubject, category: newCategory, body: newBody }),
      })
      if (code !== 201 || !('ticket' in data)) {
        setCreateError(errorMessage(code, data as { error?: string }))
        return
      }
      setCreateOpen(false)
      setNewSubject('')
      setNewBody('')
      setNewCategory('GENERAL')
      await loadTickets(1, statusFilter)
      openTicket(data.ticket.publicId)
    } catch {
      setCreateError('Network error. Please retry.')
    } finally {
      setCreating(false)
    }
  }

  const active = detail?.ticket ?? tickets.find((ticket) => ticket.publicId === selectedId) ?? null
  const closed = active?.status === 'CLOSED'
  const totalMessagePages = detail ? Math.max(1, Math.ceil(detail.messages.total / detail.messages.pageSize)) : 1

  return (
    <div className="min-h-dvh">
      <SpaceBackground />
      <div className="relative z-10 mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-slate-100">Support</h1>
            <p className="mt-1 text-sm text-[#94A3B8]">Ask the PFT desk about rules, payouts, KYC or your account.</p>
          </div>
          <Button className="h-9 gap-2" onClick={() => { setCreateError(null); setCreateOpen(true) }}>
            <MessageSquarePlus className="size-4" /> New request
          </Button>
        </header>

        <div className="mt-5 grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
          {/* Ticket list */}
          <section className={cn('min-w-0 rounded-xl border border-slate-800/80 bg-[#0B0F19]/85 backdrop-blur-md', selectedId ? 'hidden lg:block' : 'block')}>
            <div className="flex items-center justify-between gap-2 border-b border-slate-800/80 px-3 py-2.5">
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as '' | Status)}
                className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background/70 px-2 font-mono text-[11px] text-foreground outline-none focus-visible:border-ring"
                aria-label="Filter tickets by status"
              >
                <option value="">All statuses</option>
                {STATUSES.map((status) => (
                  <option key={status} value={status}>{STATUS_LABEL[status]}</option>
                ))}
              </select>
              <Button variant="ghost" size="icon-sm" onClick={() => void loadTickets(listPage, statusFilter)} aria-label="Refresh tickets" disabled={loadingList}>
                {loadingList ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              </Button>
            </div>

            <div className="max-h-[calc(100dvh-260px)] overflow-y-auto">
              {loadingList ? (
                <p className="flex items-center gap-2 px-3 py-8 text-xs text-[#94A3B8]"><Loader2 className="size-4 animate-spin" /> Loading tickets…</p>
              ) : listError ? (
                <div className="px-3 py-6 text-xs text-danger">
                  <p>{listError}</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => void loadTickets(listPage, statusFilter)}>Retry</Button>
                </div>
              ) : tickets.length === 0 ? (
                <div className="px-4 py-10 text-center">
                  <Inbox className="mx-auto size-5 text-[#94A3B8]" />
                  <p className="mt-2 text-xs text-[#94A3B8]">No requests yet. Start one and the desk will reply here.</p>
                </div>
              ) : (
                <ul className="divide-y divide-slate-800/70">
                  {tickets.map((ticket) => (
                    <li key={ticket.publicId}>
                      <button
                        type="button"
                        onClick={() => openTicket(ticket.publicId)}
                        aria-current={selectedId === ticket.publicId ? 'true' : undefined}
                        className={cn(
                          'w-full px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                          selectedId === ticket.publicId ? 'bg-primary/10' : 'hover:bg-slate-800/40',
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium text-slate-100">{ticket.subject}</span>
                          <span className={cn('shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide', STATUS_STYLE[ticket.status])}>
                            {STATUS_LABEL[ticket.status]}
                          </span>
                        </div>
                        <p className="mt-1 flex items-center gap-2 font-mono text-[10px] text-[#94A3B8]">
                          <span>{ticket.publicId}</span>·<span>{ticket.category}</span>·<span>{ticket.messageCount} msg</span>
                        </p>
                        <p className="mt-0.5 font-mono text-[10px] text-slate-500">Updated {formatTime(ticket.updatedAt)}</p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-slate-800/80 px-3 py-2 text-[10px] text-[#94A3B8]">
              <Button variant="ghost" size="xs" disabled={listPage <= 1 || loadingList} onClick={() => void loadTickets(listPage - 1, statusFilter)}>Older</Button>
              <span className="font-mono">{listTotal === 0 ? '0' : `${listPage} / ${Math.max(1, Math.ceil(listTotal / PAGE_SIZE))}`}</span>
              <Button variant="ghost" size="xs" disabled={listPage >= Math.ceil(listTotal / PAGE_SIZE) || loadingList} onClick={() => void loadTickets(listPage + 1, statusFilter)}>Newer</Button>
            </div>
          </section>

          {/* Conversation */}
          <section className={cn('min-w-0 flex-col rounded-xl border border-slate-800/80 bg-[#0B0F19]/85 backdrop-blur-md', selectedId ? 'flex' : 'hidden lg:flex')}>
            {!selectedId ? (
              <div className="flex flex-1 flex-col items-center justify-center p-10 text-center">
                <MessageSquarePlus className="size-6 text-[#94A3B8]" />
                <p className="mt-3 text-sm text-slate-200">Select a request</p>
                <p className="mt-1 max-w-sm text-xs text-[#94A3B8]">Your conversation with the PFT desk will appear here.</p>
              </div>
            ) : (
              <>
                <header className="flex items-start gap-2 border-b border-slate-800/80 px-3 py-2.5">
                  <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={() => setSelectedId(null)} aria-label="Back to tickets">
                    <ArrowLeft className="size-4" />
                  </Button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-100">{active?.subject ?? 'Ticket'}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[10px] text-[#94A3B8]">
                      <span>{active?.publicId}</span>
                      <span>{active?.category}</span>
                      <span>Opened {active ? formatDate(active.createdAt) : '—'}</span>
                    </p>
                  </div>
                  {active ? (
                    <span className={cn('shrink-0 rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide', STATUS_STYLE[active.status])}>
                      {STATUS_LABEL[active.status]}
                    </span>
                  ) : null}
                </header>

                <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-4">
                  {detailLoading && !detail ? (
                    <p className="flex items-center gap-2 text-xs text-[#94A3B8]"><Loader2 className="size-4 animate-spin" /> Loading conversation…</p>
                  ) : detailError ? (
                    <div className="text-xs text-danger">
                      <p>{detailError}</p>
                      <Button variant="outline" size="sm" className="mt-3" onClick={() => selectedId && void loadDetail(selectedId, 1)}>Retry</Button>
                    </div>
                  ) : detail ? (
                    <>
                      {detail.messages.page > 1 ? (
                        <div className="mb-3 text-center">
                          <Button variant="ghost" size="xs" disabled={detailLoading} onClick={() => selectedId && void loadDetail(selectedId, detail.messages.page - 1)}>
                            Load older messages
                          </Button>
                        </div>
                      ) : null}
                      <ul className="flex flex-col gap-3">
                        {detail.messages.items.map((message) => {
                          const mine = message.senderType === 'TRADER'
                          return (
                            <li key={message.id} className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
                              <div className={cn('max-w-[85%] rounded-xl border px-3 py-2 sm:max-w-[75%]', mine ? 'border-primary/25 bg-primary/10' : 'border-slate-800 bg-[#111A2D]')}>
                                <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-[#94A3B8]">
                                  {mine ? 'You' : message.senderType === 'AI' ? 'PFT Assistant' : 'PFT Support'}
                                </p>
                                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-100">{message.body}</p>
                                <p className="mt-1 font-mono text-[9px] text-slate-500">{formatTime(message.createdAt)}</p>
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                      {detail.messages.page < totalMessagePages ? (
                        <div className="mt-3 text-center">
                          <Button variant="ghost" size="xs" disabled={detailLoading} onClick={() => selectedId && void loadDetail(selectedId, detail.messages.page + 1)}>
                            Load newer messages
                          </Button>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </div>

                <div className="border-t border-slate-800/80 p-3">
                  {closed ? (
                    <p className="rounded-md border border-slate-800 bg-secondary/40 px-3 py-2 text-xs text-[#94A3B8]">
                      This request is closed. Create a new request if you need further help.
                    </p>
                  ) : (
                    <form onSubmit={(event) => void sendMessage(event)} className="flex items-end gap-2">
                      <label className="min-w-0 flex-1">
                        <span className="sr-only">Message</span>
                        <textarea
                          value={draft}
                          onChange={(event) => setDraft(event.target.value)}
                          rows={2}
                          maxLength={5000}
                          placeholder="Write a message…"
                          className="max-h-40 min-h-10 w-full resize-y rounded-md border border-input bg-background/70 px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.shiftKey) {
                              event.preventDefault()
                              event.currentTarget.form?.requestSubmit()
                            }
                          }}
                        />
                      </label>
                      <Button type="submit" className="h-10 gap-2" disabled={sending || draft.trim().length === 0}>
                        {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                        <span className="hidden sm:inline">{sending ? 'Sending…' : 'Send'}</span>
                      </Button>
                    </form>
                  )}
                  {sendError ? <p role="alert" className="mt-2 text-xs text-danger">{sendError}</p> : null}
                </div>
              </>
            )}
          </section>
        </div>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="border-border bg-card sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New support request</DialogTitle>
            <DialogDescription>Describe the issue with as much detail as possible. The desk replies inside this ticket.</DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void createTicket(event)} className="grid gap-3">
            <label className="grid gap-1 text-xs text-muted-foreground">
              Subject
              <input
                value={newSubject}
                onChange={(event) => setNewSubject(event.target.value)}
                required
                minLength={4}
                maxLength={160}
                placeholder="Short summary"
                className="h-9 rounded-md border border-input bg-background/70 px-2 text-sm text-foreground outline-none focus-visible:border-ring"
              />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              Category
              <select
                value={newCategory}
                onChange={(event) => setNewCategory(event.target.value as Category)}
                className="h-9 rounded-md border border-input bg-background/70 px-2 font-mono text-xs text-foreground outline-none focus-visible:border-ring"
              >
                {CATEGORIES.map((category) => (
                  <option key={category} value={category}>{category}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              Message
              <textarea
                value={newBody}
                onChange={(event) => setNewBody(event.target.value)}
                required
                maxLength={5000}
                rows={5}
                placeholder="What happened, and what would you like us to check?"
                className="rounded-md border border-input bg-background/70 px-2 py-2 text-sm text-foreground outline-none focus-visible:border-ring"
              />
            </label>
            {createError ? <p role="alert" className="text-xs text-danger">{createError}</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
                <X className="size-3.5" /> Cancel
              </Button>
              <Button type="submit" disabled={creating || newSubject.trim().length < 4 || newBody.trim().length === 0}>
                {creating ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                {creating ? 'Creating…' : 'Create request'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
