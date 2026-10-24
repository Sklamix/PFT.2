'use client'

import { useCallback, useEffect, useState } from 'react'
import { BadgeCheck, CircleAlert, Clock3, ExternalLink, LoaderCircle, LockKeyhole, RefreshCw, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'

type KycStatus = 'NOT_STARTED' | 'PENDING' | 'APPROVED' | 'REJECTED'
type ChallengeStatus = 'IN_PROGRESS' | 'PASSED' | 'FAILED'

type KycState = {
  kycStatus: KycStatus
  challengeStatus: ChallengeStatus
  kycVerifiedAt: string | null
  kycNote: string | null
  kycUpdatedAt: string | null
  hasSession: boolean
}

const STATUS_COPY: Record<KycStatus, { label: string; className: string }> = {
  NOT_STARTED: { label: 'Not verified', className: 'border-slate-500/30 bg-slate-500/10 text-slate-300' },
  PENDING: { label: 'Verification in progress', className: 'border-amber-400/30 bg-amber-400/10 text-amber-200' },
  APPROVED: { label: 'Account verified', className: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' },
  REJECTED: { label: 'Verification rejected', className: 'border-rose-400/30 bg-rose-400/10 text-rose-200' },
}

function formatDate(value: string | null) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function KYCSection() {
  const [state, setState] = useState<KycState | null>(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/kyc/status', { cache: 'no-store' })
      const data = (await response.json().catch(() => ({}))) as KycState & { error?: string }
      if (!response.ok) throw new Error(data.error || 'Unable to load verification status.')
      setState(data)
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load verification status.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (state?.kycStatus !== 'PENDING') return
    const timer = window.setInterval(() => void load(), 5_000)
    return () => window.clearInterval(timer)
  }, [load, state?.kycStatus])

  async function startKyc() {
    setStarting(true)
    setError(null)
    try {
      const response = await fetch('/api/kyc/session', { method: 'POST' })
      const data = (await response.json().catch(() => ({}))) as { session_url?: string; url?: string; error?: string }
      if (!response.ok) throw new Error(data.error || 'Unable to start verification.')
      const url = data.session_url ?? data.url
      if (!url) throw new Error('Didit did not return a verification link.')
      window.location.assign(url)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to start verification.')
      setStarting(false)
    }
  }

  const badge = state ? STATUS_COPY[state.kycStatus] : null
  const challengePassed = state?.challengeStatus === 'PASSED'
  const canStart = challengePassed && (state?.kycStatus === 'NOT_STARTED' || state?.kycStatus === 'REJECTED')

  return (
    <section className="relative mt-8 overflow-hidden rounded-2xl border border-white/10 bg-[#0b1117]/85 p-5 shadow-[0_24px_80px_-48px_rgba(163,230,53,0.45)] backdrop-blur-xl sm:p-8">
      <div className="pointer-events-none absolute -top-24 -right-16 size-56 rounded-full bg-lime-400/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-28 -left-16 size-56 rounded-full bg-cyan-400/10 blur-3xl" />

      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 grid size-10 place-items-center rounded-xl border border-lime-300/20 bg-lime-300/10 text-lime-200">
            <ShieldCheck className="size-5" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-lime-300">Identity verification</p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight text-white">KYC with Didit</h2>
            <p className="mt-1 max-w-xl text-sm leading-6 text-slate-400">
              Verify your identity once to unlock payouts and keep your funded account compliant.
            </p>
          </div>
        </div>
        {badge && (
          <span className={cn('inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold', badge.className)}>
            <span className="size-1.5 rounded-full bg-current" />
            {badge.label}
          </span>
        )}
      </div>

      {loading ? (
        <div className="relative mt-6 flex items-center gap-2 text-sm text-slate-400">
          <LoaderCircle className="size-4 animate-spin" /> Loading verification state…
        </div>
      ) : !state ? (
        <div className="relative mt-6 rounded-xl border border-rose-400/20 bg-rose-400/5 p-4 text-sm text-rose-200">
          {error ?? 'Verification state is unavailable.'}
        </div>
      ) : (
        <div className="relative mt-6 space-y-4">
          {!challengePassed && (
            <div className="flex gap-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] p-4">
              <LockKeyhole className="mt-0.5 size-5 shrink-0 text-amber-200" />
              <div>
                <p className="text-sm font-semibold text-amber-100">KYC unlocks after your challenge</p>
                <p className="mt-1 text-sm leading-6 text-amber-100/70">
                  Verification becomes available only after you successfully complete the challenge and move to a Funded account.
                </p>
              </div>
            </div>
          )}

          {challengePassed && state.kycStatus === 'PENDING' && (
            <div className="flex gap-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] p-4">
              <Clock3 className="mt-0.5 size-5 shrink-0 text-amber-200" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-amber-100">Verification is in progress</p>
                <p className="mt-1 text-sm leading-6 text-amber-100/70">
                  Didit is reviewing your documents. This page refreshes automatically; you can safely close it and return later.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void load()}
                className="grid size-9 shrink-0 place-items-center rounded-lg border border-amber-200/20 text-amber-100 transition hover:bg-amber-200/10"
                aria-label="Refresh verification status"
              >
                <RefreshCw className="size-4" />
              </button>
            </div>
          )}

          {challengePassed && state.kycStatus === 'APPROVED' && (
            <div className="flex gap-3 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] p-4">
              <BadgeCheck className="mt-0.5 size-5 shrink-0 text-emerald-300" />
              <div>
                <p className="text-sm font-semibold text-emerald-100">Identity verified</p>
                <p className="mt-1 text-sm text-emerald-100/70">
                  Approved {formatDate(state.kycVerifiedAt)}. Your funded account has full verification access.
                </p>
              </div>
            </div>
          )}

          {canStart && (
            <div className="rounded-xl border border-white/10 bg-white/[0.025] p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-white">
                    {state.kycStatus === 'REJECTED' ? 'Try verification again' : 'Verify your identity'}
                  </p>
                  <p className="mt-1 text-sm text-slate-400">
                    You will be redirected to Didit's secure hosted flow. It usually takes a few minutes.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void startKyc()}
                  disabled={starting}
                  className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-lime-300 px-4 text-sm font-bold text-[#11160b] transition hover:bg-lime-200 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {starting ? <LoaderCircle className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
                  {starting ? 'Opening Didit…' : state.kycStatus === 'REJECTED' ? 'Retry KYC verification' : 'Start KYC verification'}
                </button>
              </div>
              <p className="mt-3 text-xs leading-5 text-slate-500">
                By continuing you agree to Didit's{' '}
                <a href="https://didit.me/terms/verification-privacy-notice" target="_blank" rel="noreferrer" className="text-slate-300 underline decoration-white/20 underline-offset-2">
                  verification privacy notice
                </a>{' '}
                and{' '}
                <a href="https://didit.me/terms/identity-verification" target="_blank" rel="noreferrer" className="text-slate-300 underline decoration-white/20 underline-offset-2">
                  end-user terms
                </a>
                .
              </p>
            </div>
          )}

          {state.kycNote && (
            <div className="flex gap-3 rounded-xl border border-white/10 bg-white/[0.025] p-4 text-sm text-slate-300">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-slate-400" />
              <p>{state.kycNote}</p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/5 pt-4 text-xs text-slate-500">
            <span>Last update: {formatDate(state.kycUpdatedAt)}</span>
            <span className="inline-flex items-center gap-1.5">
              <span className={cn('size-1.5 rounded-full', challengePassed ? 'bg-emerald-400' : 'bg-slate-500')} />
              Challenge: {state.challengeStatus.toLowerCase().replace('_', ' ')}
            </span>
          </div>

          {error && <p className="text-sm text-rose-300">{error}</p>}
        </div>
      )}
    </section>
  )
}
