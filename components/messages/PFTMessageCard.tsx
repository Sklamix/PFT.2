'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type MessageTone = 'info' | 'pending' | 'success' | 'error' | 'neutral'

const TONES: Record<MessageTone, { accent: string; soft: string; ring: string; text: string }> = {
  info: {
    accent: '#38bdf8',
    soft: 'rgba(56,189,248,0.14)',
    ring: 'rgba(56,189,248,0.45)',
    text: 'text-sky-300',
  },
  pending: {
    accent: '#f5b942',
    soft: 'rgba(245,185,66,0.14)',
    ring: 'rgba(245,185,66,0.45)',
    text: 'text-amber-300',
  },
  success: {
    accent: '#34d399',
    soft: 'rgba(52,211,153,0.14)',
    ring: 'rgba(52,211,153,0.45)',
    text: 'text-emerald-300',
  },
  error: {
    accent: '#f87171',
    soft: 'rgba(248,113,113,0.14)',
    ring: 'rgba(248,113,113,0.45)',
    text: 'text-red-300',
  },
  neutral: {
    accent: '#94a3b8',
    soft: 'rgba(148,163,184,0.14)',
    ring: 'rgba(148,163,184,0.45)',
    text: 'text-slate-300',
  },
}

function PFTMark({ accent }: { accent: string }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="flex h-7 items-center rounded-md p-px" style={{ background: `linear-gradient(135deg, ${accent}, #0ea5e9)` }}>
        <span className="flex h-full items-center rounded-[5px] bg-[#080c14] px-2 font-mono text-[11px] font-bold tracking-[0.2em] text-white">
          PFT
        </span>
      </span>
      <span className="text-[10px] font-medium uppercase tracking-[0.32em] text-slate-500">
        Professional&nbsp;Funded&nbsp;Trader
      </span>
    </span>
  )
}

export function PFTMessageCard({
  tone = 'neutral',
  icon,
  eyebrow,
  title,
  description,
  details,
  actions,
  className,
}: {
  tone?: MessageTone
  icon?: ReactNode
  eyebrow?: string
  title: string
  description?: ReactNode
  details?: [string, string][]
  actions?: ReactNode
  className?: string
}) {
  const palette = TONES[tone]

  return (
    <section
      className={cn(
        'animate-step-in relative w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 bg-[#0B0F19]/85 p-8 text-center shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)] backdrop-blur-md',
        className,
      )}
    >
      {/* Cosmic background: tone glow + faint stars */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(600px 360px at 50% -12%, ${palette.soft}, transparent 60%), radial-gradient(500px 320px at 50% 112%, rgba(14,165,233,0.06), transparent 60%)`,
        }}
      />
      <div aria-hidden="true" className="cosmic-stars pointer-events-none absolute inset-0 opacity-40" />

      <div className="relative flex flex-col items-center">
        <PFTMark accent={palette.accent} />

        {icon ? (
          <div className="mt-7 flex justify-center" aria-hidden="true">
            <span
              className="relative flex size-14 items-center justify-center rounded-full"
              style={{ border: `1px solid ${palette.ring}` }}
            >
              <span
                className={cn('absolute inset-0 rounded-full', tone === 'pending' && 'motion-safe:animate-ping')}
                style={{ background: palette.soft }}
              />
              <span className="relative grid size-11 place-items-center rounded-full" style={{ color: palette.accent, background: palette.soft }}>
                {icon}
              </span>
            </span>
          </div>
        ) : null}

        {eyebrow ? (
          <p className={cn('mt-5 font-mono text-[11px] font-semibold uppercase tracking-[0.22em]', palette.text)}>{eyebrow}</p>
        ) : null}

        <h1 className="mt-2.5 text-2xl font-semibold tracking-tight text-white text-balance">{title}</h1>

        {description ? <p className="mt-3 max-w-md text-sm leading-6 text-slate-400 text-pretty">{description}</p> : null}

        {details && details.length > 0 ? (
          <dl className="mt-6 w-full space-y-2 rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-left text-sm">
            {details.map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-4">
                <dt className="shrink-0 text-slate-500">{label}</dt>
                <dd className="min-w-0 truncate text-right font-mono tabular-nums text-slate-200">{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {actions ? <div className="mt-7 flex w-full flex-col items-center gap-3">{actions}</div> : null}
      </div>
    </section>
  )
}
