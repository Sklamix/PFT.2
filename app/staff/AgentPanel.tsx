'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { MessageBody } from '@/components/support/chat/message-body'
import { RulesBrowser } from '@/components/support/rules-browser'

/* -------------------------------------------------------------------------- */
/* Mobile agent panel for the Support Desk app (staff APK).                   */
/* Mirrors the desktop agent panel: snapshot + reminders, Assist chat,        */
/* actions via the dispatcher, and the senior-tier escalation queue.          */
/* -------------------------------------------------------------------------- */

type Account = {
  id: string
  displayId: string
  planUsd: number | null
  challengeType: string | null
  phase: string | null
  status: string
  balance: number
  equity: number
}

type Snapshot = {
  ticket: { publicId: string; subject: string; status: string; priority: string }
  accounts: Account[]
  breaches: { displayId: string; kind: string; detectedAt: string }[]
  payouts: { id: string; amountUsd: number; status: string; createdAt: string }[]
  trades: { symbol: string; side: string; pnl: number; closedAt: string }[]
  payments: { orders: { id: string; status: string; amountUsd: number }[]; recovery: { orderId: string; status: string; reason: string | null; attempts: number }[] }
  journal: { entries7d: number; entries30d: number }
  certificates: { publicId: string; type: string; status: string }[]
  incidents: { id: string; title: string; severity: string; status: string }[]
  news: { time: string; title: string; impact: string; country: string }[]
  escalation: { requestedAction: string; reason: string; raisedAt: string } | null
}

type Reminder = { id: string; note: string; remindAt: string | null; state: string }
type Turn = { role: 'user' | 'assistant'; content: string }

const ESCALATION_ACTIONS = [
  'PROVISION_CHALLENGE_ACCOUNT',
  'PAYOUT_MANUAL_REVIEW',
  'ACCOUNT_STATE_FIX',
  'OTHER_HUMAN_DECISION',
] as const

const card = 'rounded-lg border border-border bg-card p-3 text-sm'
const btn = 'rounded-md border border-border bg-background px-2.5 py-1.5 text-xs disabled:opacity-50'
const input = 'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs'
const label = 'mt-2 block text-[11px] text-muted-foreground'

function Banner({ banner }: { banner: { ok: boolean; text: string } | null }) {
  if (!banner) return null
  return (
    <p className={`mt-2 rounded-md border px-2.5 py-1.5 text-xs ${banner.ok ? 'border-emerald-500/40 text-emerald-400' : 'border-destructive/50 text-destructive'}`}>
      {banner.text}
    </p>
  )
}

/* -------------------------------------------------------------------------- */
/* Per-ticket agent section                                                   */
/* -------------------------------------------------------------------------- */

export function AgentSection({ publicId }: { publicId: string }) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'snapshot' | 'rules' | 'assist'>('snapshot')
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null)

  const [turns, setTurns] = useState<Turn[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)

  const [reminderAt, setReminderAt] = useState('')
  const [reminderNote, setReminderNote] = useState('')
  const [escalAction, setEscalAction] = useState<string>(ESCALATION_ACTIONS[3])
  const [escalReason, setEscalReason] = useState('')
  const [appealAccount, setAppealAccount] = useState('')
  const [appealSummary, setAppealSummary] = useState('')
  const [actionBusy, setActionBusy] = useState(false)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const response = await fetch(`/api/admin/support/tickets/${encodeURIComponent(publicId)}/agent`, { cache: 'no-store' })
      if (!response.ok) {
        setLoadError(`Помилка ${response.status}`)
        return
      }
      const data = await response.json()
      setSnapshot(data.snapshot ?? null)
      setReminders(Array.isArray(data.reminders) ? data.reminders : [])
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Мережа недоступна')
    }
  }, [publicId])

  useEffect(() => {
    setSnapshot(null)
    setReminders([])
    setTurns([])
    setLoadError(null)
    setBanner(null)
    if (open) void load()
  }, [open, load])

  async function runAction(body: Record<string, unknown>) {
    setActionBusy(true)
    setBanner(null)
    try {
      const response = await fetch(`/api/admin/support/tickets/${encodeURIComponent(publicId)}/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok && !data.message) {
        setBanner({ ok: false, text: data.error || `Помилка ${response.status}` })
      } else {
        setBanner({ ok: Boolean(data.ok), text: data.message || data.error || 'Готово' })
        await load()
      }
    } catch (err) {
      setBanner({ ok: false, text: err instanceof Error ? err.message : 'Мережа недоступна' })
    } finally {
      setActionBusy(false)
    }
  }

  async function sendChat() {
    const message = chatInput.trim()
    if (!message || chatBusy) return
    setChatBusy(true)
    const nextTurns = [...turns, { role: 'user' as const, content: message }]
    setTurns(nextTurns)
    setChatInput('')
    try {
      const response = await fetch(`/api/admin/support/tickets/${encodeURIComponent(publicId)}/agent/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history: nextTurns.slice(-8) }),
      })
      const data = await response.json().catch(() => ({}))
      const reply = response.ok && typeof data.reply === 'string' ? data.reply : data.error || 'Агент недоступний'
      setTurns([...nextTurns, { role: 'assistant', content: reply }])
    } catch (err) {
      setTurns([...nextTurns, { role: 'assistant', content: err instanceof Error ? err.message : 'Мережа недоступна' }])
    } finally {
      setChatBusy(false)
    }
  }

  const accounts = snapshot?.accounts ?? []
  const activeEscalation = snapshot?.escalation ?? null

  return (
    <section className="mt-6 rounded-xl border border-border bg-card/40 p-3">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between text-sm font-medium">
        <span>Агент підтримки {activeEscalation ? '· ескалація активна' : ''}</span>
        <span className="text-muted-foreground">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <>
          <div className="mt-3 flex gap-2 text-xs">
            <button
              onClick={() => setTab('snapshot')}
              className={`rounded-full px-3 py-1 ${tab === 'snapshot' ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground'}`}
            >
              Дані клієнта
            </button>
            <button
              onClick={() => setTab('rules')}
              className={`rounded-full px-3 py-1 ${tab === 'rules' ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground'}`}
            >
              Правила
            </button>
            <button
              onClick={() => setTab('assist')}
              className={`rounded-full px-3 py-1 ${tab === 'assist' ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground'}`}
            >
              Агент (Assist)
            </button>
          </div>

          {tab === 'rules' && <RulesBrowser />}

          {loadError && <p className="mt-2 text-xs text-destructive">{loadError}</p>}

          {tab === 'snapshot' && (
            <div className="mt-3 space-y-3">
              {snapshot && (
                <>
                  {activeEscalation && (
                    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs">
                      <p className="font-medium">Ескалація: {activeEscalation.requestedAction}</p>
                      <p className="mt-0.5 opacity-80">{activeEscalation.reason}</p>
                      <button onClick={() => runAction({ action: 'resolve_escalation' })} disabled={actionBusy} className={`${btn} mt-2`}>
                        Закрити ескалацію
                      </button>
                    </div>
                  )}

                  <div className={card}>
                    <p className="mb-1 text-[11px] uppercase text-muted-foreground">Акаунти ({accounts.length})</p>
                    {accounts.length === 0 && <p className="text-xs text-muted-foreground">Немає акаунтів.</p>}
                    {accounts.map((account) => (
                      <p key={account.id} className="text-xs">
                        {account.displayId} · {account.status} · ${account.balance.toLocaleString('uk-UA')}
                        {account.phase ? ` · ${account.phase}` : ''}
                      </p>
                    ))}
                  </div>

                  <div className={card}>
                    <p className="text-xs">Журнал: {snapshot.journal.entries7d} за 7д · {snapshot.journal.entries30d} за 30д</p>
                    {snapshot.breaches.length > 0 && (
                      <p className="mt-1 text-xs text-destructive">
                        Брічі: {snapshot.breaches.map((breach) => `${breach.displayId} ${breach.kind}`).join(', ')}
                      </p>
                    )}
                    {snapshot.payouts.length > 0 && (
                      <p className="mt-1 text-xs">
                        Виплати: {snapshot.payouts.map((payout) => `${payout.status} $${payout.amountUsd}`).join(', ')}
                      </p>
                    )}
                    {snapshot.incidents.length > 0 && (
                      <p className="mt-1 text-xs text-amber-400">
                        Інциденти: {snapshot.incidents.map((incident) => `${incident.title} (${incident.severity})`).join(', ')}
                      </p>
                    )}
                  </div>

                  <div className={card}>
                    <p className="mb-1 text-[11px] uppercase text-muted-foreground">Дії</p>
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => runAction({ action: 'resend_password_email' })} disabled={actionBusy} className={btn}>
                        Повторний email
                      </button>
                    </div>
                    <label className={label}>
                      Апіл — акаунт
                      <select value={appealAccount} onChange={(event) => setAppealAccount(event.target.value)} className={input}>
                        <option value="">—</option>
                        {accounts.map((account) => (
                          <option key={account.id} value={account.id}>{account.displayId}</option>
                        ))}
                      </select>
                    </label>
                    <label className={label}>
                      Апіл — суть (мін. 20 символів)
                      <textarea value={appealSummary} onChange={(event) => setAppealSummary(event.target.value)} rows={2} className={input} />
                    </label>
                    <button
                      onClick={() => runAction({ action: 'file_appeal', accountId: appealAccount, summary: appealSummary })}
                      disabled={actionBusy || !appealAccount || appealSummary.trim().length < 20}
                      className={`${btn} mt-2`}
                    >
                      Подати апіл
                    </button>
                    <label className={label}>
                      Нагадування
                      <input type="datetime-local" value={reminderAt} onChange={(event) => setReminderAt(event.target.value)} className={input} />
                    </label>
                    <input
                      value={reminderNote}
                      onChange={(event) => setReminderNote(event.target.value)}
                      placeholder="Примітка"
                      className={`${input} mt-2`}
                    />
                    <button
                      onClick={() => runAction({ action: 'set_reminder', remindAt: reminderAt, note: reminderNote })}
                      disabled={actionBusy || !reminderAt}
                      className={`${btn} mt-2`}
                    >
                      Поставити нагадування
                    </button>
                    {reminders.length > 0 && (
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        Активні нагадування: {reminders.filter((reminder) => reminder.state === 'SCHEDULED').length}
                      </p>
                    )}
                    <label className={label}>
                      Ескалація старшому тіру
                      <select value={escalAction} onChange={(event) => setEscalAction(event.target.value)} className={input}>
                        {ESCALATION_ACTIONS.map((action) => (
                          <option key={action} value={action}>{action}</option>
                        ))}
                      </select>
                    </label>
                    <textarea
                      value={escalReason}
                      onChange={(event) => setEscalReason(event.target.value)}
                      rows={2}
                      placeholder="Причина (мін. 20 символів)"
                      className={`${input} mt-2`}
                    />
                    <button
                      onClick={() => runAction({ action: 'escalate_senior', requestedAction: escalAction, reason: escalReason })}
                      disabled={actionBusy || escalReason.trim().length < 20 || Boolean(activeEscalation)}
                      className={`${btn} mt-2`}
                    >
                      Ескалювати
                    </button>
                  </div>
                  <Banner banner={banner} />
                </>
              )}
              {!snapshot && !loadError && <p className="text-xs text-muted-foreground">Завантаження…</p>}
            </div>
          )}

          {tab === 'assist' && (
            <div className="mt-3">
              <div className="space-y-2">
                {turns.map((turn, index) => (
                  <div key={index} className={turn.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                    <div className={`max-w-[90%] rounded-lg px-2.5 py-1.5 text-xs ${turn.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-card border border-border'}`}>
                      <MessageBody text={turn.content} tone={turn.role === 'user' ? 'neutral' : 'ai'} />
                    </div>
                  </div>
                ))}
                {turns.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    Питайте агента про клієнта: акаунти, виплати, брічі, ринок. Агент тільки пропонує дії — виконання через підтвердження у вкладці «Дані клієнта».
                  </p>
                )}
              </div>
              <div className="mt-3 flex gap-2">
                <input
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void sendChat()
                    }
                  }}
                  placeholder="Питання агенту… (60/год)"
                  className={input}
                />
                <button onClick={() => void sendChat()} disabled={chatBusy || !chatInput.trim()} className={btn}>
                  {chatBusy ? '…' : 'Запитати'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* Senior escalation queue (list screen)                                      */
/* -------------------------------------------------------------------------- */

type EscalationItem = {
  escalation: { requestedAction: string; reason: string; raisedAt: string }
  ticket: { publicId: string; subject: string; status: string; trader: { email: string } } | null
}

export function EscalationsSection({ onOpenTicket }: { onOpenTicket: (publicId: string) => void }) {
  const [items, setItems] = useState<EscalationItem[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const once = useRef(false)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/support/escalations', { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      setItems(Array.isArray(data.items) ? data.items : [])
    } catch {
      setItems([])
    }
  }, [])

  useEffect(() => {
    if (once.current) return
    once.current = true
    void load()
  }, [load])

  async function resolve(publicId: string) {
    setBusy(publicId)
    try {
      await fetch(`/api/admin/support/tickets/${encodeURIComponent(publicId)}/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resolve_escalation' }),
      })
      await load()
    } finally {
      setBusy(null)
    }
  }

  if (items === null) return <p className="mt-4 text-sm text-muted-foreground">Завантаження…</p>
  if (items.length === 0) return <p className="mt-4 text-sm text-muted-foreground">Активних ескалацій немає.</p>

  return (
    <ul className="mt-4 space-y-2">
      {items.map((item) => (
        <li key={item.escalation.requestedAction + item.escalation.raisedAt} className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <button onClick={() => item.ticket && onOpenTicket(item.ticket.publicId)} className="w-full text-left">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm font-medium">{item.ticket?.subject ?? 'Тикет'}</p>
              <span className="shrink-0 text-[10px] uppercase text-amber-400">{item.escalation.requestedAction}</span>
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{item.ticket?.trader.email ?? ''} · {new Date(item.escalation.raisedAt).toLocaleString('uk-UA')}</p>
            <p className="mt-1 text-xs">{item.escalation.reason}</p>
          </button>
          {item.ticket && (
            <button onClick={() => void resolve(item.ticket!.publicId)} disabled={busy === item.ticket.publicId} className={`${btn} mt-2`}>
              {busy === item.ticket.publicId ? '…' : 'Закрити ескалацію'}
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}
