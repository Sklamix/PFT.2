'use client'

import { useRef, useState, type FormEvent } from 'react'
import { Bot, ChevronDown, ChevronUp, Loader2, Send, UserRound, LifeBuoy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AssistantRequestError,
  nextIdempotencyKey,
  requestAssistant,
  type AssistantHistoryTurn,
  type PendingKey,
} from '@/lib/ai/assistant-client'
import { cn } from '@/lib/utils'

type Turn = AssistantHistoryTurn

const MAX_MESSAGE = 1_000
const MAX_HISTORY = 6

function assistantErrorMessage(error: unknown) {
  if (error instanceof AssistantRequestError) {
    if (error.kind === 'timeout') {
      return 'No response from the assistant within 20 seconds. If your message was saved, the ticket will appear in the list below; otherwise please try again.'
    }
    if (error.kind === 'network') {
      return 'Network error — the message was not confirmed. Please check your connection and try again.'
    }
    if (error.kind === 'invalid_response') {
      return 'The assistant returned an unexpected response. Please try again or open a support ticket.'
    }
    if (error.status === 401) return 'Your session expired. Please sign in again.'
    return error.message || 'The assistant could not answer. Please try again or open a support ticket.'
  }
  return 'The assistant could not answer. Please try again or open a support ticket.'
}

export function SupportAssistant({ onHandoff }: { onHandoff: (publicId: string) => void }) {
  const [open, setOpen] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [handoff, setHandoff] = useState<{ publicId: string; reused: boolean } | null>(null)
  const pendingKey = useRef<PendingKey | null>(null)

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const message = draft.trim()
    if (!message || sending) return
    setSending(true)
    setError(null)
    setHandoff(null)

    const history = turns.slice(-MAX_HISTORY)
    const pending = nextIdempotencyKey(pendingKey.current, message)
    pendingKey.current = pending
    try {
      const data = await requestAssistant({ message, history, idempotencyKey: pending.key })
      const next: Turn[] = [...history, { role: 'user', content: message }]
      if (data.answer) next.push({ role: 'assistant', content: data.answer })
      setTurns(next)
      setDraft('')
      pendingKey.current = null
      if (data.handoff) setHandoff({ publicId: data.handoff.publicId, reused: data.handoff.reused === true })
    } catch (reason) {
      // Keep the idempotency key so retrying the same message cannot duplicate a handoff.
      setError(assistantErrorMessage(reason))
    } finally {
      setSending(false)
    }
  }

  async function talkToHuman() {
    if (sending) return
    const message = draft.trim() || 'I would like to speak to a human operator.'
    setSending(true)
    setError(null)
    setHandoff(null)
    const pending = nextIdempotencyKey(pendingKey.current, message)
    pendingKey.current = pending
    try {
      const data = await requestAssistant({ message, forceHandoff: true, history: [], idempotencyKey: pending.key })
      if (!data.handoff) {
        setError('The assistant did not confirm a support ticket. Please try again.')
        return
      }
      setTurns((current) => [...current, { role: 'user', content: message }])
      setDraft('')
      pendingKey.current = null
      setHandoff({ publicId: data.handoff.publicId, reused: data.handoff.reused === true })
    } catch (reason) {
      setError(assistantErrorMessage(reason))
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="mb-4 overflow-hidden rounded-xl border border-primary/20 bg-[#0B0F19]/85 backdrop-blur-md">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-primary/25 bg-primary/10">
          <Bot className="size-4 text-primary" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-100">PFT Assistant</span>
          <span className="block text-[11px] text-[#94A3B8]">
            Answers from the official rules (v1.6) and live pricing. Cannot change accounts or payouts.
          </span>
        </span>
        {open ? <ChevronUp className="size-4 text-[#94A3B8]" /> : <ChevronDown className="size-4 text-[#94A3B8]" />}
      </button>

      {open ? (
        <div className="border-t border-slate-800/80 px-3 py-3">
          <div className="max-h-72 overflow-y-auto">
            {turns.length === 0 ? (
              <p className="text-xs text-[#94A3B8]">
                Ask about rules, drawdown, payouts, pricing or KYC. If the assistant is unsure, it will open a real support ticket.
              </p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {turns.map((turn, index) => (
                  <li key={`${turn.role}-${index}`} className={cn('flex gap-2', turn.role === 'user' ? 'justify-end' : 'justify-start')}>
                    {turn.role === 'assistant' ? (
                      <span className="mt-1 grid size-6 shrink-0 place-items-center rounded-full border border-primary/25 bg-primary/10">
                        <Bot className="size-3 text-primary" aria-hidden="true" />
                      </span>
                    ) : null}
                    <div
                      className={cn(
                        'max-w-[85%] rounded-xl border px-3 py-2 text-sm leading-relaxed',
                        turn.role === 'user' ? 'border-primary/25 bg-primary/10 text-slate-100' : 'border-slate-800 bg-[#111A2D] text-slate-100',
                      )}
                    >
                      <p className="whitespace-pre-wrap break-words">{turn.content}</p>
                    </div>
                    {turn.role === 'user' ? (
                      <span className="mt-1 grid size-6 shrink-0 place-items-center rounded-full border border-slate-700 bg-secondary/60">
                        <UserRound className="size-3 text-[#94A3B8]" aria-hidden="true" />
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {handoff ? (
            <div
              role="status"
              aria-live="polite"
              className="mt-3 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2.5 text-xs text-emerald-200"
            >
              <p className="font-semibold">Sent to support</p>
              <p className="mt-0.5 text-emerald-300/90">
                {handoff.reused
                  ? 'Your open support ticket was updated with this message.'
                  : 'A support ticket was created for this conversation.'}
              </p>
              <p className="mt-1 font-mono text-[11px] text-emerald-200">{handoff.publicId}</p>
              <Button
                variant="outline"
                size="xs"
                className="mt-2 h-8 gap-1 border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/15"
                onClick={() => {
                  onHandoff(handoff.publicId)
                  setHandoff(null)
                }}
              >
                <LifeBuoy className="size-3.5" /> Open ticket
              </Button>
            </div>
          ) : null}

          {error ? <p role="alert" className="mt-2 text-xs text-danger">{error}</p> : null}

          <form onSubmit={(event) => void send(event)} className="mt-3 flex items-end gap-2">
            <label className="min-w-0 flex-1">
              <span className="sr-only">Message the assistant</span>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={2}
                maxLength={MAX_MESSAGE}
                placeholder="Ask about PFT rules, payouts or pricing…"
                className="max-h-32 min-h-10 w-full resize-y rounded-md border border-input bg-background/70 px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    event.currentTarget.form?.requestSubmit()
                  }
                }}
              />
            </label>
            <div className="flex flex-col gap-1">
              <Button type="submit" className="h-8 gap-1.5" disabled={sending || draft.trim().length < 2}>
                {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                <span className="hidden sm:inline">Ask</span>
              </Button>
              <Button type="button" variant="ghost" size="xs" className="h-7" disabled={sending} onClick={() => void talkToHuman()}>
                Talk to a human
              </Button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  )
}

