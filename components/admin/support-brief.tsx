'use client'

import { useState } from 'react'
import { Copy, ExternalLink } from 'lucide-react'
import { MessageBody } from '@/components/support/chat/message-body'
import { type SupportBrief } from '@/lib/support/brief'

const LABELS = {
  en: {
    empty: 'No AI brief on this ticket.',
    why: 'Why the AI handed off',
    byAgent: 'Agent-suggested',
    byUser: 'User-requested',
    bySystem: 'System fallback',
    turns: 'Last turns',
    context: 'Trader context',
    copy: 'Copy',
    copied: 'Copied',
    insert: 'Insert',
  },
  uk: {
    empty: 'На цьому тикеті немає AI-шпаргалки.',
    why: 'Чому AI передав людині',
    byAgent: 'Запропонував агент',
    byUser: 'Запросив трейдер',
    bySystem: 'Системний фолбек',
    turns: 'Останні репліки',
    context: 'Контекст трейдера',
    copy: 'Копіювати',
    copied: 'Скопійовано',
    insert: 'Вставити',
  },
} as const

/** Renders Brief data passed from the desk: reason, context, history. */
export function BriefPanel({
  brief,
  onInsert,
  locale = 'en',
}: {
  brief: SupportBrief | null
  onInsert?: (text: string) => void
  locale?: 'en' | 'uk'
}) {
  const t = LABELS[locale]
  if (!brief) {
    return <p className="px-3 py-8 text-center text-xs text-muted-foreground">{t.empty}</p>
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Reason */}
      <div className="rounded-md border border-warning/40 bg-warning/10 p-2.5">
        <p className="font-mono text-[10px] uppercase tracking-widest text-warning">{t.why}</p>
        <p className="mt-1 text-sm text-foreground">{brief.reason}</p>
        <p className="mt-1 font-mono text-[9px] text-muted-foreground">
          {brief.source === 'agent' ? t.byAgent : brief.source === 'user' ? t.byUser : t.bySystem} · v{brief.rulesVersion}
        </p>
        <div className="mt-2">
          <QuickCopy text={`Reason: ${brief.reason}\nSource: ${brief.source} · v${brief.rulesVersion}`} onInsert={onInsert} labels={t} />
        </div>
      </div>

      {/* History */}
      {brief.history.length > 0 ? (
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{t.turns}</p>
          <div className="mt-2 max-h-40 space-y-1.5 overflow-y-auto">
            {brief.history.map((turn, index) => (
              <div key={index} className="rounded-md border border-border/60 bg-secondary/30 p-2 text-xs">
                <span className="font-mono text-[9px] font-semibold text-primary">{turn.role === 'user' ? 'Trader:' : 'Assistant:'}</span>{' '}
                <MessageBody text={turn.content} />
              </div>
            ))}
          </div>
          <div className="mt-1">
            <QuickCopy text={brief.history.map((t2) => `${t2.role === 'user' ? 'Trader' : 'Assistant'}: ${t2.content}`).join('\n')} onInsert={onInsert} labels={t} />
          </div>
        </div>
      ) : null}

      {/* Context */}
      <div>
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{t.context}</p>
        <div className="mt-2 space-y-1.5 text-xs">
          <div className="rounded-md border border-border/60 bg-secondary/30 p-2">
            <span className="font-mono text-[9px] text-muted-foreground">KYC: </span>
            <span className="font-mono">{brief.context.kycStatus}</span>
          </div>
          {brief.context.accounts.map((account) => (
            <div key={account.displayId} className="rounded-md border border-border/60 bg-secondary/30 p-2">
              <span className="font-mono text-[9px] text-muted-foreground">{account.displayId}</span>{' '}
              <span className="text-muted-foreground">·</span>{' '}
              <span className="text-[10px] text-foreground">{account.status}</span>{' '}
              <span className="text-muted-foreground">·</span>{' '}
              <span className="font-mono text-[10px] text-foreground">${account.planSize.toLocaleString('en-US')}</span>{' '}
              <span className="text-muted-foreground">·</span>{' '}
              <span className="font-mono text-[10px] text-muted-foreground">{account.phase}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function QuickCopy({
  text,
  onInsert,
  labels,
}: {
  text: string
  onInsert?: (text: string) => void
  labels: { copy: string; copied: string; insert: string }
}) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex gap-1">
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          } catch {
            // Ignore — copy is a convenience.
          }
        }}
        className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
        aria-label="Copy brief text"
      >
        <Copy className="size-3" aria-hidden="true" />
        {copied ? labels.copied : labels.copy}
      </button>
      <button
        type="button"
        onClick={() => onInsert?.(text)}
        disabled={!onInsert}
        className="inline-flex items-center gap-1 rounded border border-primary/30 bg-primary/10 px-2 py-1 text-[10px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-30"
        aria-label="Insert brief into reply"
      >
        <ExternalLink className="size-3" aria-hidden="true" />
        {labels.insert}
      </button>
    </div>
  )
}
