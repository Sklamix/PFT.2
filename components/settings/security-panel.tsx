'use client'

import { useMemo, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff, KeyRound, Loader2, Lock, LogOut, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Field, INPUT_CLASS, Notice, Panel } from './ui'
import { cn } from '@/lib/utils'

type SecuritySummary = {
  singleSessionModel: boolean
  lastSignInAt: string | null
  lastSignInLabel: string | null
  lastSignInIp: string | null
  lastSignInCountry: string | null
  lastDevice: string | null
  lastPasswordChangedAt: string | null
  lastPasswordChangedLabel: string | null
  twoFactorEnabled: boolean
  twoFactorSupported: boolean
}

type HistoryEntry = { id: string; label: string; action?: string; reason?: string | null; ip?: string | null; country?: string | null; device?: string | null }

const ACTION_LABELS: Record<string, string> = {
  PASSWORD_CHANGED: 'Password changed',
  SESSIONS_REVOKED_ALL: 'All sessions signed out',
  SESSION_RISK_SIGNAL: 'Sign-in risk alert',
}

function passwordScore(value: string) {
  let score = 0
  if (value.length >= 8) score += 1
  if (value.length >= 12) score += 1
  if (/[A-Z]/.test(value) && /[a-z]/.test(value)) score += 1
  if (/\d/.test(value)) score += 1
  if (/[^A-Za-z0-9]/.test(value)) score += 1
  return Math.min(score, 5)
}

export function SecurityPanel({
  security,
  signIns,
  events,
  onReload,
}: {
  security: SecuritySummary
  signIns: HistoryEntry[]
  events: HistoryEntry[]
  onReload: () => void
}) {
  const router = useRouter()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [signOutBusy, setSignOutBusy] = useState(false)
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const score = useMemo(() => passwordScore(newPassword), [newPassword])
  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword
  const canSubmit = currentPassword.length > 0 && newPassword.length >= 8 && newPassword === confirmPassword && !busy

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      const response = await fetch('/api/settings/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      })
      const data = (await response.json().catch(() => ({}))) as { error?: string; message?: string }
      if (!response.ok) throw new Error(data.error ?? 'Unable to change the password.')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setSuccess(data.message ?? 'Password updated.')
      onReload()
      router.refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to change the password.')
    } finally {
      setBusy(false)
    }
  }

  async function revokeAll() {
    setSignOutBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/settings/sessions', { method: 'POST' })
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? 'Unable to sign out all sessions.')
      }
      router.replace('/auth/login')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to sign out all sessions.')
      setSignOutBusy(false)
      setConfirmSignOut(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Password" description="Use at least 8 characters. Changing it signs out every other device.">
        <form onSubmit={(event) => void changePassword(event)} className="grid gap-4 sm:grid-cols-2">
          <Field label="Current password" className="sm:col-span-2">
            <input
              type={reveal ? 'text' : 'password'}
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
              className={INPUT_CLASS}
              required
            />
          </Field>
          <Field
            label="New password"
            hint={
              <span className="flex items-center gap-2">
                <span className="flex gap-1" aria-hidden="true">
                  {[0, 1, 2, 3, 4].map((index) => (
                    <span
                      key={index}
                      className={cn(
                        'h-1 w-6 rounded-full',
                        index < score ? (score <= 2 ? 'bg-danger' : score === 3 ? 'bg-warning' : 'bg-primary') : 'bg-secondary',
                      )}
                    />
                  ))}
                </span>
                {['Very weak', 'Weak', 'Fair', 'Good', 'Strong'][Math.max(0, score - 1)] ?? 'Very weak'}
              </span>
            }
          >
            <input
              type={reveal ? 'text' : 'password'}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
              minLength={8}
              maxLength={200}
              className={INPUT_CLASS}
              required
            />
          </Field>
          <Field label="Confirm new password" hint={mismatch ? <span className="text-danger">Passwords do not match.</span> : undefined}>
            <input
              type={reveal ? 'text' : 'password'}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              className={INPUT_CLASS}
              required
            />
          </Field>

          <div className="flex items-center justify-between gap-3 sm:col-span-2">
            <button
              type="button"
              onClick={() => setReveal((value) => !value)}
              className="inline-flex items-center gap-2 text-xs text-muted-foreground transition hover:text-foreground"
              aria-pressed={reveal}
            >
              {reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              {reveal ? 'Hide passwords' : 'Show passwords'}
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
              {busy ? 'Updating…' : 'Update password'}
            </button>
          </div>

          {error ? <div className="sm:col-span-2"><Notice tone="error">{error}</Notice></div> : null}
          {success ? <div className="sm:col-span-2"><Notice tone="success">{success}</Notice></div> : null}
        </form>
      </Panel>

      <Panel
        title="Active session"
        description={
          security.singleSessionModel
            ? 'PFT keeps a single active session per account. Signing in on another device ends the previous session.'
            : undefined
        }
      >
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Last sign-in</dt>
            <dd className="mt-0.5 font-mono text-xs tabular-nums text-foreground">{security.lastSignInLabel ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Device</dt>
            <dd className="mt-0.5 font-mono text-xs text-foreground">{security.lastDevice ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">IP address</dt>
            <dd className="mt-0.5 font-mono text-xs text-foreground">{security.lastSignInIp ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Password last changed</dt>
            <dd className="mt-0.5 font-mono text-xs text-foreground">{security.lastPasswordChangedLabel ?? 'Never'}</dd>
          </div>
        </dl>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border/60 pt-4">
          {confirmSignOut ? (
            <>
              <p className="text-xs text-muted-foreground">Sign out of every device, including this one?</p>
              <button
                type="button"
                onClick={() => void revokeAll()}
                disabled={signOutBusy}
                className="inline-flex h-8 items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 text-xs font-semibold text-danger transition hover:bg-danger/15 disabled:opacity-60"
              >
                {signOutBusy ? <Loader2 className="size-3.5 animate-spin" /> : <LogOut className="size-3.5" />}
                Yes, sign out everywhere
              </button>
              <button
                type="button"
                onClick={() => setConfirmSignOut(false)}
                className="h-8 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmSignOut(true)}
              className="inline-flex h-8 items-center gap-2 rounded-md border border-border px-3 text-xs text-foreground transition hover:border-danger/40 hover:text-danger"
            >
              <LogOut className="size-3.5" /> Sign out of all devices
            </button>
          )}
        </div>
      </Panel>

      <Panel
        title="Two-factor authentication"
        description="An additional verification step when signing in."
      >
        <div className="flex items-start gap-3 rounded-md border border-border/70 bg-secondary/30 p-3">
          {security.twoFactorSupported ? (
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
          ) : (
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          )}
          <div className="text-xs leading-relaxed text-muted-foreground">
            <p className="font-medium text-foreground">{security.twoFactorEnabled ? 'Enabled' : 'Not available yet'}</p>
            <p className="mt-1">
              PFT does not currently run a two-factor provider. Instead of a toggle that does nothing, sign-in protection
              relies on email verification codes, single-session enforcement and sign-in risk alerts. We will publish 2FA
              here once a supported provider is integrated.
            </p>
          </div>
        </div>
      </Panel>

      <Panel title="Security history" description="Recent sign-ins and account security events, shown in your preferred timezone.">
        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              <Lock className="size-3" /> Recent sign-ins
            </h3>
            {signIns.length === 0 ? (
              <p className="text-xs text-muted-foreground">No sign-in history recorded yet.</p>
            ) : (
              <ul className="divide-y divide-border/60">
                {signIns.map((entry) => (
                  <li key={entry.id} className="flex items-center justify-between gap-3 py-2 text-xs">
                    <span className="min-w-0 truncate font-mono text-foreground">
                      {[entry.country, entry.ip].filter(Boolean).join(' · ') || 'Unknown location'}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{entry.label}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              <KeyRound className="size-3" /> Account events
            </h3>
            {events.length === 0 ? (
              <p className="text-xs text-muted-foreground">No password or session changes recorded yet.</p>
            ) : (
              <ul className="divide-y divide-border/60">
                {events.map((entry) => (
                  <li key={entry.id} className="flex items-center justify-between gap-3 py-2 text-xs">
                    <span className="min-w-0 truncate text-foreground">
                      {ACTION_LABELS[entry.action ?? ''] ?? entry.reason ?? entry.action}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{entry.label}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Panel>
    </div>
  )
}
