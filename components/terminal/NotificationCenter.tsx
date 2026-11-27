'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Bell, CheckCheck, ChevronDown, Mail, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useNotifications, type NotificationItem, type NotificationKind } from '@/lib/stores/useNotifications'
import { useTerminalBook } from '@/lib/stores/useTerminalBook'
import { cn } from '@/lib/utils'

const FILTERS: Array<{ id: NotificationKind | 'ALL'; label: string }> = [
  { id: 'ALL', label: 'All' },
  { id: 'order', label: 'Orders' },
  { id: 'account', label: 'Account' },
  { id: 'payment', label: 'Payments' },
  { id: 'rule', label: 'Rules' },
]

function formatRelativeTime(createdAt: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - createdAt) / 1000))
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds} sec ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} d ago`
  return new Date(createdAt).toLocaleDateString()
}

const TONE_DOT: Record<string, string> = {
  success: 'bg-primary',
  danger: 'bg-danger',
  info: 'bg-primary',
  warning: 'bg-warning',
}

export function NotificationCenter() {
  const items = useNotifications((state) => state.items)
  const markRead = useNotifications((state) => state.markRead)
  const markAllRead = useNotifications((state) => state.markAllRead)
  const remove = useNotifications((state) => state.remove)
  const clear = useNotifications((state) => state.clear)
  const selectPosition = useTerminalBook((state) => state.selectPosition)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<NotificationKind | 'ALL'>('ALL')
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest')
  const [emailingId, setEmailingId] = useState<string | null>(null)
  const [sentIds, setSentIds] = useState<string[]>([])
  const [retryAt, setRetryAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (retryAt == null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [retryAt])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  const unread = items.filter((item) => !item.read).length
  const visible = useMemo(() => {
    const filtered = filter === 'ALL' ? items : items.filter((item) => item.kind === filter)
    return [...filtered].sort((a, b) => (sort === 'newest' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt))
  }, [items, filter, sort])

  const lastItem = useMemo(() => items[0] ?? null, [items])

  function openNotification(item: NotificationItem) {
    markRead(item.id)
    if (item.ref?.kind === 'position') {
      selectPosition(item.ref.id)
      document.getElementById('positions-table')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
    setOpen(false)
  }

  async function emailNotification(item: NotificationItem) {
    if (emailingId) return
    setEmailingId(item.id)
    try {
      const response = await fetch('/api/notifications/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: [item.id],
          items: [{ id: item.id, title: item.title, message: item.message }],
        }),
      })
      if (response.status === 429) {
        const data = (await response.json().catch(() => ({}))) as { retryAfterMs?: number }
        setRetryAt(Date.now() + (typeof data.retryAfterMs === 'number' ? data.retryAfterMs : 60_000))
        return
      }
      if (!response.ok) return
      setSentIds((previous) => (previous.includes(item.id) ? previous : [...previous, item.id]))
    } finally {
      setEmailingId(null)
    }
  }

  const retrySeconds = retryAt == null ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000))

  return (
    <div className="relative shrink-0">
      <Button
        type="button"
        aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ''}. Open notification center`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        className="h-7 rounded-md bg-emerald-500 px-3 text-emerald-950 hover:bg-emerald-400"
      >
        <Bell className="size-3.5" aria-hidden="true" />
        <span className="font-mono text-[10px] uppercase tracking-widest">Notifications</span>
        {unread > 0 ? (
          <span className="rounded-full bg-emerald-950/20 px-1.5 font-mono text-[10px] tabular-nums text-emerald-950">
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
        <ChevronDown className={cn('size-3.5 text-emerald-950 transition-transform duration-300', open && 'rotate-180')} aria-hidden="true" />
      </Button>
      {lastItem && !open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="ml-2 hidden max-w-40 truncate text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 sm:block"
        >
          {lastItem.title}: {lastItem.message}
        </button>
      ) : null}
      {open ? (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-full z-50 mt-2 w-96 max-w-[calc(100vw-3rem)] rounded-lg border border-border bg-card p-2 shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 px-1 pb-2">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Notifications</p>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="h-6 gap-1 px-1.5 text-[10px]"
                onClick={() => markAllRead()}
                aria-label="Mark all notifications read"
              >
                <CheckCheck className="size-3" aria-hidden="true" />
                Mark all read
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="h-6 gap-1 px-1.5 text-[10px]"
                onClick={() => clear()}
                aria-label="Clear notifications"
              >
                <Trash2 className="size-3" aria-hidden="true" />
                Clear
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1 px-1 pb-2">
            {FILTERS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setFilter(option.id)}
                className={cn(
                  'rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                  filter === option.id
                    ? 'border-primary/40 bg-primary/15 text-primary'
                    : 'border-border bg-secondary/40 text-muted-foreground hover:text-foreground',
                )}
              >
                {option.label}
              </button>
            ))}
            <label className="ml-auto flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              Sort
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value === 'oldest' ? 'oldest' : 'newest')}
                aria-label="Notification sort order"
                className="h-6 rounded-md border border-border bg-background px-1.5 font-mono text-[10px] text-foreground"
              >
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
              </select>
            </label>
          </div>
          <div ref={listRef} className="max-h-80 divide-y divide-border overflow-y-auto">
            {visible.length === 0 ? (
              <p className="px-2 py-8 text-center font-mono text-[11px] text-muted-foreground">No notifications yet. Orders, payments and account events will appear here.</p>
            ) : (
              visible.map((item) => (
                <div key={item.id} className={cn('flex items-start gap-2 px-2 py-2', !item.read && 'bg-primary/5')}>
                  <span className={cn('mt-1 size-1.5 shrink-0 rounded-full', TONE_DOT[item.tone] ?? TONE_DOT.info)} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-[12px] text-foreground">{item.title}</p>
                    <p className="font-mono text-[11px] text-muted-foreground">{item.message}</p>
                    <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">{formatRelativeTime(item.createdAt)}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {item.ref?.kind === 'position' ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="h-6 gap-1 px-1.5 text-[10px]"
                        onClick={() => openNotification(item)}
                      >
                        Open
                      </Button>
                    ) : null}
                    {item.action ? (
                      item.action.href ? (
                        <a
                          href={item.action.href}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex h-6 items-center rounded-md bg-emerald-500 px-3 text-[10px] font-semibold text-emerald-950 transition hover:bg-emerald-400"
                        >
                          {item.action.label}
                        </a>
                      ) : item.action.onOpen ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          className="h-6 px-1.5 text-[10px]"
                          onClick={() => {
                            item.action?.onOpen?.()
                          }}
                        >
                          {item.action.label}
                        </Button>
                      ) : null
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="h-6 gap-1 px-1.5 text-[10px]"
                      onClick={() => void emailNotification(item)}
                      disabled={emailingId != null}
                    >
                      <Mail className="size-3" aria-hidden="true" />
                      {emailingId === item.id ? 'Sending…' : sentIds.includes(item.id) ? 'Sent' : 'Email'}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="size-6"
                      aria-label={`Dismiss ${item.title} notification`}
                      onClick={() => remove(item.id)}
                    >
                      <X className="size-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
          {retryAt != null ? (
            <p className="px-2 pt-2 font-mono text-[10px] text-warning">Try again in 0:{String(retrySeconds).padStart(2, '0')}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
