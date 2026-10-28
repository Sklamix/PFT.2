'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Send } from 'lucide-react'
import { cn } from '@/lib/utils'

type Audience = 'ALL' | 'ADMIN' | 'RISK_MANAGER'

type Message = {
  id: string
  subject: string
  body: string
  audience: Audience
  createdByName: string | null
  createdAt: string
}

const AUDIENCE_LABEL: Record<Audience, string> = {
  ALL: 'All staff',
  ADMIN: 'Admins',
  RISK_MANAGER: 'Risk managers',
}

const dateFmt = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

export function StaffMessages() {
  const [messages, setMessages] = useState<Message[]>([])
  const [audienceFilter, setAudienceFilter] = useState<Audience>('ALL')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [audience, setAudience] = useState<Audience>('ALL')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/admin/messages?audience=${audienceFilter}`, { cache: 'no-store' })
      const data = (await response.json().catch(() => null)) as { messages?: Message[] } | null
      if (response.ok && data?.messages) setMessages(data.messages)
    } catch {
      // Panel is non-critical; keep the previous list on transient errors.
    }
  }, [audienceFilter])

  useEffect(() => {
    void load()
  }, [load])

  const send = async () => {
    setBusy(true)
    setError(null)
    setSent(false)
    try {
      const response = await fetch('/api/admin/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, body, audience }),
      })
      const data = (await response.json().catch(() => null)) as { error?: string } | null
      if (!response.ok) throw new Error(data?.error || 'Unable to send the message')
      setSubject('')
      setBody('')
      setSent(true)
      if (audienceFilter === 'ALL' || audienceFilter === audience) await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to send the message')
    }
    setBusy(false)
  }

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex flex-col gap-3 border-b border-border p-4">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Staff messages</h2>
          <p className="text-xs text-muted-foreground">Broadcast announcements to employees, sorted by class.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(['ALL', 'ADMIN', 'RISK_MANAGER'] as Audience[]).map((value) => (
            <Button
              key={value}
              size="xs"
              variant={audienceFilter === value ? 'default' : 'outline'}
              onClick={() => setAudienceFilter(value)}
            >
              {AUDIENCE_LABEL[value]}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 p-4 lg:grid-cols-2">
        {/* Compose */}
        <div className="grid content-start gap-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">New broadcast</p>
          <select
            value={audience}
            onChange={(event) => setAudience(event.target.value as Audience)}
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
            aria-label="Audience"
          >
            {(['ALL', 'ADMIN', 'RISK_MANAGER'] as Audience[]).map((value) => (
              <option key={value} value={value}>
                To: {AUDIENCE_LABEL[value]}
              </option>
            ))}
          </select>
          <input
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="Subject"
            maxLength={120}
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
          />
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={4000}
            placeholder="Message to staff (min 10 characters)…"
            className="min-h-28 rounded-md border border-border bg-background p-2 text-sm"
          />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          {sent ? <p className="text-xs text-primary">Message delivered to the selected class.</p> : null}
          <Button size="sm" disabled={busy || subject.trim().length < 3 || body.trim().length < 10} onClick={() => void send()}>
            <Send />
            {busy ? 'Sending…' : `Send to ${AUDIENCE_LABEL[audience]}`}
          </Button>
        </div>

        {/* History */}
        <div className="grid content-start gap-2">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Sent ({messages.length})
          </p>
          {messages.length === 0 ? (
            <p className="text-xs text-muted-foreground">No messages for this class yet.</p>
          ) : (
            <ul className="grid max-h-96 gap-2 overflow-y-auto">
              {messages.map((message) => (
                <li key={message.id} className="rounded-lg border border-border bg-secondary/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-foreground">{message.subject}</p>
                    <span
                      className={cn(
                        'rounded border px-1.5 py-0.5 font-mono text-[10px]',
                        message.audience === 'ADMIN' && 'border-primary/40 text-primary',
                        message.audience === 'RISK_MANAGER' && 'border-warning/40 text-warning',
                        message.audience === 'ALL' && 'border-border text-muted-foreground',
                      )}
                    >
                      {AUDIENCE_LABEL[message.audience]}
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{message.body}</p>
                  <p className="mt-2 font-mono text-[10px] text-muted-foreground">
                    {message.createdByName ?? 'Admin'} · {dateFmt(message.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}
