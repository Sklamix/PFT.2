'use client'

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { AlertTriangle, Bot, ChevronDown, ChevronUp, Loader2, Send, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BriefPanel } from '@/components/admin/support-brief'
import { MessageBody } from '@/components/support/chat/message-body'
import { RulesBrowser } from '@/components/support/rules-browser'
import { cn } from '@/lib/utils'

/**
 * Staff-side agent panel for one support ticket: Snapshot / Assist / History.
 *
 * The panel is mount-agnostic: it owns only its data and rendering and never
 * assumes the surrounding layout, so the same component works as a desktop
 * third column and as a vertical accordion on smaller screens (and later
 * inside the staff PWA without changes here).
 */

type AgentSnapshot = {
  ticket: { publicId: string; subject: string; category: string; status: string; priority: string }
  accounts: Record<string, unknown>[]
  objectives: Record<string, unknown>[]
  breaches: Record<string, unknown>[]
  payouts: Record<string, unknown>[]
  trades: Record<string, unknown>[]
  payments: Record<string, unknown>
  journal: { entries7d: number; entries30d: number }
  certificates: Record<string, unknown>[]
  incidents: Record<string, unknown>[]
  news: Record<string, unknown>[]
  escalation: {
    publicId: string
    requestedAction: string
    reason: string
    raisedAt: string
  } | null
}

type Reminder = { id: string; note: string | null; remindAt: string | null; state: string }

type AgentTab = 'snapshot' | 'brief' | 'rules' | 'assist' | 'history'

type AssistTurn = { role: 'user' | 'assistant'; content: string }

const ESCALATION_ACTIONS = [
  'PROVISION_CHALLENGE_ACCOUNT',
  'PAYOUT_MANUAL_REVIEW',
  'ACCOUNT_STATE_FIX',
  'OTHER_HUMAN_DECISION',
] as const

const ACTION_LABEL: Record<string, string> = {
  PROVISION_CHALLENGE_ACCOUNT: 'Зробити акаунт челенджа',
  PAYOUT_MANUAL_REVIEW: 'Перегляд виплати людиною',
  ACCOUNT_STATE_FIX: 'Виправити стан акаунта',
  OTHER_HUMAN_DECISION: 'Рішення людини',
}

// Which admin-desk section the owner jumps to for a given escalation action.
function sectionForAction(action: string): 'monitor' | 'reviews' | 'operations' | 'support' | null {
  if (action === 'PROVISION_CHALLENGE_ACCOUNT' || action === 'ACCOUNT_STATE_FIX') return 'operations'
  if (action === 'PAYOUT_MANUAL_REVIEW') return 'reviews'
  return 'support'
}

async function api<T>(url: string, init?: RequestInit): Promise<{ status: number; data: T | { error?: string } }> {
  const response = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers }, cache: 'no-store' })
  return { status: response.status, data: await response.json().catch(() => ({})) }
}

function errorText(status: number, payload: { error?: string }) {
  if (status === 401) return 'Session expired — sign in again.'
  if (status >= 500) return payload.error ?? 'The agent service is unavailable.'
  return payload.error ?? 'Request failed.'
}

function Section({ title, value }: { title: string; value: Record<string, unknown>[] | Record<string, unknown> }) {
  const [open, setOpen] = useState(false)
  const empty = Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0
  return (
    <div className="rounded-md border border-border/70">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{title}</span>
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-[10px] text-muted-foreground">{empty ? 'empty' : String(Array.isArray(value) ? value.length : 'data')}</span>
          {open ? <ChevronUp className="size-3 text-muted-foreground" /> : <ChevronDown className="size-3 text-muted-foreground" />}
        </span>
      </button>
      {open ? (
        <pre className="max-h-48 overflow-auto border-t border-border/60 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-foreground">
          {JSON.stringify(value, null, 2)}
        </pre>
      ) : null}
    </div>
  )
}

/** One-line human summary, computed locally from the snapshot. */
function snapshotSummary(snapshot: AgentSnapshot): string {
  const parts: string[] = []
  const breaches = snapshot.breaches.length
  if (breaches > 0) parts.push(`${breaches} breach${breaches > 1 ? 'es' : ''}`)
  const pendingPayout = snapshot.payouts.find((payout) => payout.status === 'PENDING')
  if (pendingPayout) parts.push('payout pending')
  const openRecovery = (snapshot.payments.recovery as { status: string }[]).filter((row) => row.status !== 'RESOLVED').length
  if (openRecovery > 0) parts.push(`${openRecovery} payment recovery`)
  if (snapshot.incidents.length > 0) parts.push(`${snapshot.incidents.length} active incident(s)`)
  if (snapshot.journal.entries30d > 0) parts.push(`${snapshot.journal.entries30d} journal entries (30d)`)
  return parts.length > 0 ? parts.join(' · ') : 'No notable signals.'
}

export function SupportAgentPanel({ ticketId, brief, onInsertReply }: { ticketId: string; brief: import('@/lib/support/brief').SupportBrief | null; onInsertReply?: (text: string) => void }) {
  const [tab, setTab] = useState<AgentTab>('snapshot')
  const [open, setOpen] = useState(false)

  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null)
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [turns, setTurns] = useState<AssistTurn[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [assistError, setAssistError] = useState<string | null>(null)

  // A pending action waits for a confirmation in a modal (tier 2/4 clicks).
  const [pendingAction, setPendingAction] = useState<
    { tool: 'file_appeal' | 'resend_password_email' | 'set_reminder' | 'escalate_senior' | 'resolve_escalation'; args: Record<string, unknown>; label: string } | null
  >(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionResult, setActionResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [escalationReason, setEscalationReason] = useState('')

  const chatEndRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    setSnapshot(null)
    setReminders([])
    setTurns([])
    setActionResult(null)
    setPendingAction(null)
    try {
      const { status: code, data } = await api<{ snapshot: AgentSnapshot; reminders: Reminder[] }>(
        `/api/admin/support/tickets/${encodeURIComponent(ticketId)}/agent`,
      )
      if (code !== 200 || !('snapshot' in data)) {
        setLoadError(errorText(code, data as { error?: string }))
        setSnapshot(null)
        return
      }
      setSnapshot(data.snapshot)
      setReminders(data.reminders)
    } catch {
      setLoadError('Network error. Retry.')
    } finally {
      setLoading(false)
    }
  }, [ticketId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (open && tab === 'assist') chatEndRef.current?.scrollIntoView({ block: 'end' })
  }, [open, tab, turns])

  async function sendAssist(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sending || draft.trim().length === 0) return
    setSending(true)
    setAssistError(null)
    try {
      const { status: code, data } = await api<{ reply: string }>(
        `/api/admin/support/tickets/${encodeURIComponent(ticketId)}/agent/chat`,
        { method: 'POST', body: JSON.stringify({ message: draft, history: turns.slice(-10) }) },
      )
      if (code !== 200 || !('reply' in data)) {
        setAssistError(errorText(code, data as { error?: string }))
        return
      }
      setTurns((current) => [
        ...current,
        { role: 'user' as const, content: draft },
        { role: 'assistant' as const, content: data.reply },
      ])
      setDraft('')
    } catch {
      setAssistError('Network error. The agent did not answer.')
    } finally {
      setSending(false)
    }
  }

  const requestAction = useCallback((tool: typeof pendingAction extends null ? never : NonNullable<typeof pendingAction>['tool'], args: Record<string, unknown>, label: string) => {
    setActionResult(null)
    setPendingAction({ tool, args, label })
  }, [])

  async function runPendingAction() {
    if (!pendingAction || !ticketId || actionBusy) return
    setActionBusy(true)
    try {
      const { status: code, data } = await api<{ ok?: boolean; message?: string }>(
        `/api/admin/support/tickets/${encodeURIComponent(ticketId)}/agent`,
        { method: 'POST', body: JSON.stringify({ action: pendingAction.tool, ...(pendingAction.tool === 'escalate_senior' ? { ...pendingAction.args, reason: escalationReason } : pendingAction.args) }) },
      )
      if (code >= 200 && code < 300 && data && 'message' in data) {
        setActionResult({ ok: true, message: (data as { message: string }).message })
        setPendingAction(null)
        await load()
      } else {
        setActionResult({ ok: false, message: errorText(code, data as { error?: string }) })
      }
    } catch {
      setActionResult({ ok: false, message: 'Network error. The action was not executed.' })
    } finally {
      setActionBusy(false)
    }
  }

  const hasActiveEscalation = snapshot?.escalation !== null && snapshot?.escalation !== undefined

  const confirmReady = (() => {
    if (!pendingAction) return false
    if (pendingAction.tool === 'file_appeal') return Boolean(pendingAction.args.accountId) && String(pendingAction.args.summary ?? '').trim().length >= 20
    if (pendingAction.tool === 'escalate_senior') return Boolean(pendingAction.args.requestedAction) && escalationReason.trim().length >= 10
    if (pendingAction.tool === 'set_reminder') return Boolean(pendingAction.args.remindAt)
    return true
  })()

  return (
    <div className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 border-b border-border/70 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <Bot className="size-3.5 text-primary" aria-hidden="true" />
        <span className="min-w-0 flex-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Agent</span>
        {hasActiveEscalation ? <ShieldAlert className="size-3.5 text-warning" aria-label="Active escalation" /> : null}
        {open ? <ChevronUp className="size-3.5 text-muted-foreground" /> : <ChevronDown className="size-3.5 text-muted-foreground" />}
      </button>

      {open ? (
        <div className="flex flex-col">
          <nav className="flex gap-1 border-b border-border/70 px-2 py-1.5" aria-label="Agent tabs">
            {(['snapshot', 'brief', 'rules', 'assist', 'history'] as const).map((item) => (
              <Button key={item} size="xs" variant={tab === item ? 'default' : 'ghost'} onClick={() => setTab(item)} className="capitalize">
                {item}
              </Button>
            ))}
          </nav>

          <div className="p-3">
            {actionResult ? (
              <p
                role={actionResult.ok ? 'status' : 'alert'}
                className={cn('mb-2 rounded-md border px-2.5 py-1.5 text-xs', actionResult.ok ? 'border-primary/30 bg-primary/10 text-primary' : 'border-destructive/40 bg-destructive/10 text-destructive')}
              >
                {actionResult.message}
              </p>
            ) : null}

            {tab === 'brief' ? <BriefPanel brief={brief} onInsert={onInsertReply} /> : null}
            {tab === 'rules' ? <RulesBrowser onInsert={onInsertReply} /> : null}

            {tab === 'snapshot' ? (
              loading ? (
                <p className="flex items-center gap-2 py-6 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Loading snapshot…</p>
              ) : loadError || !snapshot ? (
                <div className="py-6 text-xs text-destructive">
                  <p>{loadError ?? 'Snapshot unavailable.'}</p>
                  <Button variant="outline" size="xs" className="mt-2" onClick={() => void load()}>Retry</Button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="rounded-md border border-border/70 bg-secondary/40 px-2.5 py-1.5 text-xs text-foreground">{snapshotSummary(snapshot)}</p>
                  {snapshot.escalation ? (
                    <div className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs text-foreground">
                      <p className="font-mono text-[10px] uppercase tracking-widest text-warning">{snapshot.escalation.requestedAction}</p>
                      <p className="mt-0.5 text-muted-foreground">{snapshot.escalation.reason}</p>
                      <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{new Date(snapshot.escalation.raisedAt).toLocaleString('en-GB')}</p>
                      {sectionForAction(snapshot.escalation.requestedAction) ? (
                        <Button
                          variant="outline"
                          size="xs"
                          className="mt-1.5"
                          onClick={() => { window.location.hash = sectionForAction(snapshot.escalation!.requestedAction) ?? 'operations' }}
                        >
                          Open section
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  <Section title="Accounts" value={snapshot.accounts} />
                  <Section title="Objectives" value={snapshot.objectives} />
                  <Section title="Breaches" value={snapshot.breaches} />
                  <Section title="Payouts (read-only)" value={snapshot.payouts} />
                  <Section title="Trades" value={snapshot.trades} />
                  <Section title="Payments" value={snapshot.payments} />
                  <Section title="Certificates" value={snapshot.certificates} />
                  {snapshot.incidents.length > 0 ? (
                    <p className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs text-foreground">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" aria-hidden="true" />
                      {snapshot.incidents.map((incident) => incident.title).join(' · ')}
                    </p>
                  ) : null}
                </div>
              )
            ) : tab === 'assist' ? (
              <div className="flex flex-col gap-2">
                <div className="max-h-64 overflow-y-auto">
                  {turns.length === 0 ? (
                    <p className="py-4 text-xs text-muted-foreground">Ask the agent about this ticket. It sees the snapshot and active incidents.</p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {turns.map((turn, index) => (
                        <li
                          key={`${turn.role}-${index}`}
                          className={cn('max-w-[90%] rounded-xl border px-2.5 py-1.5 text-xs leading-relaxed text-foreground break-words', turn.role === 'user' ? 'self-end border-primary/25 bg-primary/10' : 'self-start border-border bg-secondary/40')}
                        >
                          <MessageBody text={turn.content} tone={turn.role === 'user' ? 'neutral' : 'ai'} />
                        </li>
                      ))}
                      <div ref={chatEndRef} />
                    </ul>
                  )}
                </div>

                <div className="flex flex-wrap gap-1.5">
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={sending || !snapshot || snapshot.accounts.length === 0}
                    onClick={() => requestAction('file_appeal', { accountId: '', summary: '' }, 'File appeal')}
                  >
                    File appeal
                  </Button>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={sending}
                    onClick={() => requestAction('resend_password_email', {}, 'Resend password email')}
                  >
                    Resend password email
                  </Button>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={sending}
                    onClick={() => requestAction('set_reminder', { remindAt: '', note: '' }, 'Set reminder')}
                  >
                    Set reminder
                  </Button>
                  {hasActiveEscalation ? (
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={sending}
                      onClick={() => requestAction('resolve_escalation', {}, 'Mark escalation resolved')}
                    >
                      Resolve escalation
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={sending}
                      onClick={() => { setEscalationReason(''); requestAction('escalate_senior', { requestedAction: '', reason: '' }, 'Escalate to senior tier') }}
                    >
                      Escalate to senior tier
                    </Button>
                  )}
                </div>

                {assistError ? <p role="alert" className="text-xs text-destructive">{assistError}</p> : null}

                <form onSubmit={(event) => void sendAssist(event)} className="flex items-end gap-2">
                  <label className="min-w-0 flex-1">
                    <span className="sr-only">Ask the agent</span>
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      rows={2}
                      maxLength={2000}
                      className="min-h-9 w-full resize-y rounded-md border border-input bg-background/70 px-2 py-1.5 text-xs text-foreground outline-none focus-visible:border-ring"
                    />
                  </label>
                  <Button type="submit" size="sm" className="h-9" disabled={sending || draft.trim().length === 0}>
                    {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                  </Button>
                </form>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {reminders.length === 0 && !snapshot?.escalation ? (
                  <p className="py-4 text-xs text-muted-foreground">No reminders or escalations on this ticket yet.</p>
                ) : null}
                {reminders.map((reminder) => (
                  <div key={reminder.id} className="rounded-md border border-border/70 px-2.5 py-1.5 text-xs text-foreground">
                    <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      Reminder · {reminder.remindAt ? new Date(reminder.remindAt).toLocaleString('en-GB') : '—'}
                    </p>
                    {reminder.note ? <p className="mt-0.5 text-muted-foreground">{reminder.note}</p> : null}
                  </div>
                ))}
                {snapshot?.escalation ? (
                  <div className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs text-foreground">
                    <p className="font-mono text-[10px] uppercase tracking-widest text-warning">Escalated · {snapshot.escalation.requestedAction}</p>
                    <p className="mt-0.5 text-muted-foreground">{snapshot.escalation.reason}</p>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {pendingAction ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label={pendingAction.label}>
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-4">
            <p className="text-sm font-semibold text-foreground">{pendingAction.label}</p>
            <p className="mt-1 text-xs text-muted-foreground">Confirm the action. It will be recorded in the audit log.</p>

            {pendingAction.tool === 'file_appeal' ? (
              <label className="mt-3 grid gap-1 text-xs text-muted-foreground">
                Account
                <select
                  value={String(pendingAction.args.accountId ?? '')}
                  onChange={(event) => setPendingAction({ ...pendingAction, args: { ...pendingAction.args, accountId: event.target.value } })}
                  className="h-8 rounded-md border border-input bg-background/70 px-1.5 font-mono text-[11px] text-foreground"
                >
                  <option value="">Select…</option>
                  {(snapshot?.accounts ?? []).map((account) => (
                    <option key={String(account.displayId)} value={String(account.id)}>
                      {String(account.displayId)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {pendingAction.tool === 'file_appeal' || pendingAction.tool === 'escalate_senior' ? (
              <label className="mt-2 grid gap-1 text-xs text-muted-foreground">
                {pendingAction.tool === 'escalate_senior' ? 'Escalation reason (min 10 chars)' : 'Appeal summary (min 20 chars)'}
                <textarea
                  value={pendingAction.tool === 'escalate_senior' ? escalationReason : String(pendingAction.args.summary ?? '')}
                  onChange={(event) =>
                    pendingAction.tool === 'escalate_senior'
                      ? setEscalationReason(event.target.value)
                      : setPendingAction({ ...pendingAction, args: { ...pendingAction.args, summary: event.target.value } })
                  }
                  rows={3}
                  maxLength={300}
                  className="resize-y rounded-md border border-input bg-background/70 px-2 py-1.5 text-xs text-foreground"
                />
              </label>
            ) : null}
            {pendingAction.tool === 'escalate_senior' ? (
              <label className="mt-2 grid gap-1 text-xs text-muted-foreground">
                Requested action
                <select
                  value={String(pendingAction.args.requestedAction ?? '')}
                  onChange={(event) => setPendingAction({ ...pendingAction, args: { ...pendingAction.args, requestedAction: event.target.value } })}
                  className="h-8 rounded-md border border-input bg-background/70 px-1.5 font-mono text-[11px] text-foreground"
                >
                  <option value="">Select…</option>
                  {ESCALATION_ACTIONS.map((action) => (
                    <option key={action} value={action}>{ACTION_LABEL[action]}</option>
                  ))}
                </select>
              </label>
            ) : null}
            {pendingAction.tool === 'set_reminder' ? (
              <>
                <label className="mt-3 grid gap-1 text-xs text-muted-foreground">
                  Remind at
                  <input
                    type="datetime-local"
                    value={String(pendingAction.args.remindAt ?? '')}
                    onChange={(event) => setPendingAction({ ...pendingAction, args: { ...pendingAction.args, remindAt: event.target.value ? new Date(event.target.value).toISOString() : '' } })}
                    className="h-8 rounded-md border border-input bg-background/70 px-1.5 font-mono text-[11px] text-foreground"
                  />
                </label>
                <label className="mt-2 grid gap-1 text-xs text-muted-foreground">
                  Note (optional)
                  <input
                    value={String(pendingAction.args.note ?? '')}
                    onChange={(event) => setPendingAction({ ...pendingAction, args: { ...pendingAction.args, note: event.target.value } })}
                    maxLength={200}
                    className="h-8 rounded-md border border-input bg-background/70 px-1.5 text-xs text-foreground"
                  />
                </label>
              </>
            ) : null}

            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPendingAction(null)} disabled={actionBusy}>Cancel</Button>
              <Button size="sm" onClick={() => void runPendingAction()} disabled={actionBusy || !confirmReady}>
                {actionBusy ? <Loader2 className="size-3.5 animate-spin" /> : null} Confirm
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
