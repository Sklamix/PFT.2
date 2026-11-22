'use client'

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { BrandLogo } from '@/components/brand-logo'
import { AgentSection, EscalationsSection } from './AgentPanel'

type TicketSummary = {
  publicId: string
  subject: string
  category: string
  status: string
  priority: string
  createdAt: string
  updatedAt: string
  messageCount: number
  trader: { name: string | null; email: string }
  assignedTo: { id: string; name: string; email: string } | null
}

type TicketMessage = {
  id: string
  senderType: 'TRADER' | 'STAFF' | 'AI'
  body: string
  createdAt: string
  senderName: string | null
}

const STATUS_LABELS: Record<string, string> = {
  OPEN: 'Новий',
  WAITING_FOR_STAFF: 'Відповісти',
  WAITING_FOR_USER: 'Очікує клієнта',
  RESOLVED: 'Вирішено',
  CLOSED: 'Закрито',
}

const PRIORITY_LABELS: Record<string, string> = {
  LOW: 'низький',
  NORMAL: 'звичайний',
  HIGH: 'високий',
  URGENT: 'терміново',
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  return Uint8Array.from(raw, (char) => char.charCodeAt(0))
}

export default function StaffApp() {
  const [me, setMe] = useState<{ name?: string } | null>(null)
  const [loadingSession, setLoadingSession] = useState(true)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [tickets, setTickets] = useState<TicketSummary[]>([])
  const [statusFilter, setStatusFilter] = useState('')
  const [listLoading, setListLoading] = useState(false)

  const [openTicket, setOpenTicket] = useState<{ ticket: TicketSummary; messages: TicketMessage[] } | null>(null)
  const [reply, setReply] = useState('')
  const [replyBusy, setReplyBusy] = useState(false)
  const [pushState, setPushState] = useState<'unknown' | 'on' | 'off' | 'unsupported'>('unknown')
  const [showEscalations, setShowEscalations] = useState(false)

  const meSubRef = useRef<string | null>(null)

  const loadSession = useCallback(async () => {
    const response = await fetch('/api/admin/auth/me', { cache: 'no-store' })
    if (response.ok) {
      const data = await response.json()
      setMe(data.user ?? null)
      meSubRef.current = data.user?.sub ?? null
    } else {
      setMe(null)
      meSubRef.current = null
    }
    setLoadingSession(false)
  }, [])

  useEffect(() => void loadSession(), [loadSession])

  // Surface any crash in the WebView instead of a blank screen.
  useEffect(() => {
    const report = (message: string) => alert(`Помилка сторінки: ${message}`)
    const onError = (event: ErrorEvent) => report(event.message)
    const onRejection = (event: PromiseRejectionEvent) => report(String(event.reason))
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  const loadTickets = useCallback(async () => {
    setListLoading(true)
    try {
      const query = new URLSearchParams({ sort: 'updated', pageSize: '25' })
      if (statusFilter) query.set('status', statusFilter)
      const response = await fetch(`/api/admin/support/tickets?${query}`, { cache: 'no-store' })
      if (response.status === 401) {
        setMe(null)
        return
      }
      const data = await response.json()
      if (response.ok) setTickets(data.items ?? [])
    } finally {
      setListLoading(false)
    }
  }, [statusFilter])

  useEffect(() => {
    if (!me) return
    void loadTickets()
    const timer = setInterval(() => void loadTickets(), 30_000)
    return () => clearInterval(timer)
  }, [me, loadTickets])

  // A push notification deep-links here as /staff?ticket=SUP-...
  useEffect(() => {
    if (!me) return
    const ref = new URLSearchParams(window.location.search).get('ticket')
    if (ref) void openByRef(ref)
  }, [me])

  async function onLogin(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setLoginError(null)
    try {
      const response = await fetch('/api/admin/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Не вдалося увійти')
      await loadSession()
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Не вдалося увійти')
    } finally {
      setBusy(false)
    }
  }

  async function enablePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      setPushState('unsupported')
      return
    }
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      setPushState('off')
      return
    }
    const registration = await navigator.serviceWorker.register('/staff-sw.js')
    await navigator.serviceWorker.ready
    const { publicKey } = await (await fetch('/api/support/push/subscribe', { cache: 'no-store' })).json()
    if (!publicKey) return
    const existing = await registration.pushManager.getSubscription()
    const subscription = existing ?? await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    })
    const response = await fetch('/api/support/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    })
    setPushState(response.ok ? 'on' : 'off')
  }

  async function openByRef(ref: string) {
    try {
      const response = await fetch(`/api/admin/support/tickets/${encodeURIComponent(ref)}`, { cache: 'no-store' })
      if (!response.ok) {
        alert(`Не вдалося завантажити тикет: server ${response.status}`)
        return
      }
      const data = await response.json()
      // The API returns messages paginated: { items: [...] }
      const messages = Array.isArray(data.messages) ? data.messages : data.messages?.items ?? []
      setOpenTicket({ ticket: data.ticket, messages })
    } catch (err) {
      alert(`Помилка мережі: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function sendReply(event: FormEvent) {
    event.preventDefault()
    if (!openTicket || !reply.trim()) return
    setReplyBusy(true)
    try {
      const key = `staff-web-${crypto.randomUUID()}`
      const response = await fetch(
        `/api/admin/support/tickets/${encodeURIComponent(openTicket.ticket.publicId)}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: reply.trim(), idempotencyKey: key }),
        },
      )
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Не вдалося надіслати')
      setReply('')
      await openByRef(openTicket.ticket.publicId)
      await loadTickets()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Помилка надсилання')
    } finally {
      setReplyBusy(false)
    }
  }

  async function patchTicket(patch: Record<string, unknown>) {
    if (!openTicket) return
    setBusy(true)
    try {
      await fetch(`/api/admin/support/tickets/${encodeURIComponent(openTicket.ticket.publicId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      await openByRef(openTicket.ticket.publicId)
      await loadTickets()
    } finally {
      setBusy(false)
    }
  }

  if (loadingSession) {
    return <div className="flex min-h-dvh items-center justify-center bg-deck text-sm text-muted-foreground">Завантаження…</div>
  }

  if (!me) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-deck px-4">
        <form onSubmit={onLogin} className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-[0_0_40px_-20px] shadow-primary/40">
          <BrandLogo />
          <h1 className="mt-5 text-lg font-semibold tracking-tight">Support Desk</h1>
          <p className="mt-1 text-sm text-muted-foreground">Доступ лише для працівників підтримки.</p>
          <label className="mt-5 block text-xs text-muted-foreground">
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
              required
              autoComplete="email"
            />
          </label>
          <label className="mt-3 block text-xs text-muted-foreground">
            Пароль
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
              required
              autoComplete="current-password"
            />
          </label>
          {loginError && <p className="mt-3 text-sm text-destructive">{loginError}</p>}
          <button
            type="submit"
            disabled={busy}
            className="mt-5 h-9 w-full rounded-md bg-primary text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy ? 'Вхід…' : 'Увійти'}
          </button>
        </form>
      </div>
    )
  }

  if (openTicket) {
    const t = openTicket.ticket
    return (
      <div className="min-h-dvh bg-deck">
        <header className="sticky top-0 z-10 border-b border-border bg-card/80 px-4 py-3 backdrop-blur">
          <div className="flex items-center gap-3">
            <button onClick={() => setOpenTicket(null)} className="text-sm text-muted-foreground" aria-label="Назад">
              ← Назад
            </button>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{t.subject}</p>
              <p className="truncate text-xs text-muted-foreground">{t.trader.email} · {t.publicId}</p>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-border px-2 py-0.5">{STATUS_LABELS[t.status] ?? t.status}</span>
            <span className="rounded-full border border-border px-2 py-0.5">{PRIORITY_LABELS[t.priority] ?? t.priority}</span>
            {t.assignedTo && <span className="rounded-full border border-border px-2 py-0.5">Виконує: {t.assignedTo.name}</span>}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {!t.assignedTo && (
              <button onClick={() => patchTicket({ assignedToId: meSubRef.current })} className="rounded-md border border-border bg-background px-2 py-1 text-xs">
                Взяти на себе
              </button>
            )}
            {t.status !== 'RESOLVED' && (
              <button onClick={() => patchTicket({ status: 'RESOLVED' })} className="rounded-md border border-border bg-background px-2 py-1 text-xs">
                Позначити вирішеним
              </button>
            )}
            {t.status !== 'CLOSED' && (
              <button onClick={() => patchTicket({ status: 'CLOSED' })} className="rounded-md border border-border bg-background px-2 py-1 text-xs">
                Закрити
              </button>
            )}
          </div>
        </header>
        <main className="mx-auto max-w-2xl px-4 py-4">
          <div className="space-y-3">
            {openTicket.messages.map((message) => {
              const mine = message.senderType !== 'TRADER'
              return (
                <div key={message.id} className={mine ? 'flex justify-end' : 'flex justify-start'}>
                  <div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${mine ? 'bg-primary text-primary-foreground' : 'bg-card border border-border'}`}>
                    <p className="mb-1 text-[10px] uppercase opacity-60">
                      {message.senderType === 'TRADER' ? (message.senderName || t.trader.name || 'Клієнт') : message.senderType === 'AI' ? 'AI' : 'Ви'}
                    </p>
                    <p className="whitespace-pre-wrap">{message.body}</p>
                    <p className="mt-1 text-[10px] opacity-50">{new Date(message.createdAt).toLocaleString('uk-UA')}</p>
                  </div>
                </div>
              )
            })}
          </div>
          <AgentSection publicId={t.publicId} />
          <form onSubmit={sendReply} className="sticky bottom-4 mt-6 flex gap-2">
            <textarea
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              rows={2}
              placeholder="Ваша відповідь…"
              className="min-h-11 flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={replyBusy || !reply.trim()}
              className="h-11 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {replyBusy ? '…' : 'Надіслати'}
            </button>
          </form>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-dvh bg-deck">
      <header className="sticky top-0 z-10 border-b border-border bg-card/80 px-4 py-3 backdrop-blur">
        <div className="flex items-center justify-between">
          <BrandLogo />
          <span className="text-xs text-muted-foreground">{me.name || 'Працівник'}</span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          {['', 'WAITING_FOR_STAFF', 'OPEN', 'RESOLVED'].map((value) => (
            <button
              key={value || 'all'}
              onClick={() => setStatusFilter(value)}
              className={`rounded-full px-3 py-1 text-xs ${statusFilter === value ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground'}`}
            >
              {value ? STATUS_LABELS[value] : 'Усі'}
            </button>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-between">
          <button onClick={() => void enablePush()} className="text-xs text-muted-foreground underline">
            {pushState === 'on' ? 'Пуші увімкнено ✓' : 'Увімкнути push-повідомлення'}
          </button>
          <button
            onClick={() => setShowEscalations(!showEscalations)}
            className={`rounded-full px-3 py-1 text-xs ${showEscalations ? 'bg-amber-500/20 text-amber-400' : 'border border-border text-muted-foreground'}`}
          >
            Ескалації
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-4">
        {showEscalations && <EscalationsSection onOpenTicket={(ref) => void openByRef(ref)} />}
        {!showEscalations && (
        <>
        {listLoading && tickets.length === 0 && <p className="text-sm text-muted-foreground">Завантаження…</p>}
        {!listLoading && tickets.length === 0 && <p className="text-sm text-muted-foreground">Тикетів немає.</p>}
        <ul className="space-y-2">
          {tickets.map((ticket) => (
            <li key={ticket.publicId}>
              <button
                onClick={() => void openByRef(ticket.publicId)}
                className="w-full rounded-xl border border-border bg-card px-4 py-3 text-left"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-medium">{ticket.subject}</p>
                  <span className="shrink-0 text-[10px] uppercase text-muted-foreground">{STATUS_LABELS[ticket.status]}</span>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {ticket.trader.email} · {ticket.messageCount} повідомл. · {new Date(ticket.updatedAt).toLocaleString('uk-UA')}
                </p>
              </button>
            </li>
          ))}
        </ul>
        </>
        )}
      </main>
    </div>
  )
}
