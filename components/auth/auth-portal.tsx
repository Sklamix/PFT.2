'use client'

import { FormEvent, useEffect, useState } from 'react'
import { signIn } from 'next-auth/react'
import { ArrowRight, LoaderCircle, ShieldCheck } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { BrandLogo } from '@/components/brand-logo'
import { KineticOrbit } from '@/components/auth/kinetic-orbit'

const INPUT_CLASS =
  'mt-2 h-12 w-full rounded-lg border border-border bg-card px-4 text-sm text-white outline-none transition placeholder:text-muted-foreground/60 focus:border-primary focus:ring-2 focus:ring-primary/25 focus:shadow-[0_0_18px_-8px_rgba(67,136,255,0.8)]'

export function AuthPortal({ googleEnabled }: { googleEnabled: boolean }) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [stage, setStage] = useState<'email' | 'password' | 'code'>('email')
  const [codeFlow, setCodeFlow] = useState<'login' | 'step-up'>('login')
  const [busy, setBusy] = useState(false)
  const [resendIn, setResendIn] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  useEffect(() => {
    if (resendIn <= 0) return
    const timer = window.setTimeout(() => setResendIn((value) => Math.max(0, value - 1)), 1000)
    return () => window.clearTimeout(timer)
  }, [resendIn])

  async function resolveMethod(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const response = await fetch('/api/auth/login-method', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to check the sign-in method.')
      if (data.method === 'password') {
        setStage('password')
        setBusy(false)
      } else {
        setCodeFlow('login')
        await requestCode()
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to check the sign-in method.')
      setBusy(false)
    }
  }

  async function signInWithPassword(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Unable to sign in.')
      if (data.stepUp) {
        // Suspicious sign-in (new IP or repeated failures): fall back to the code step.
        setCodeFlow('step-up')
        setStage('code')
        setResendIn(60)
        setPassword('')
        setInfo('For your safety we sent a six-digit code to your email. Enter it to finish signing in.')
        setBusy(false)
        return
      }
      router.replace('/dashboard')
      router.refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to sign in.')
      setBusy(false)
    }
  }

  async function requestCode(event?: FormEvent) {
    event?.preventDefault()
    if (resendIn > 0) return
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const response = await fetch('/api/auth/email-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to send a code.')
      setStage('code')
      setResendIn(60)
      setInfo('If this email can use PFT sign-in, a code has been sent to it.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to send a code.')
    } finally {
      setBusy(false)
    }
  }

  async function resendStepUpCode() {
    if (resendIn > 0) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/auth/step-up-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to send a code.')
      setResendIn(60)
      setInfo('If this email can use PFT sign-in, a code has been sent to it.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to send a code.')
    } finally {
      setBusy(false)
    }
  }

  async function verifyCode(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(codeFlow === 'step-up' ? '/api/auth/verify-step-up' : '/api/auth/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to verify the code.')
      router.replace(data.redirectTo || '/dashboard')
      router.refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to verify the code.')
      setBusy(false)
    }
  }

  return (
    <main className="min-h-dvh bg-background text-white">
      <div className="grid min-h-dvh lg:grid-cols-[minmax(430px,0.92fr)_1.08fr]">
        <section id="auth-form" className="relative flex min-h-dvh items-center justify-center px-6 py-24 sm:px-12">
          <div className="w-full max-w-md">
            <BrandLogo href="/" />
            <div className="mt-16">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary">Trader access</p>
              <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">
                {stage === 'email' ? 'Welcome to your edge.' : stage === 'password' ? 'Enter your password.' : 'Check your inbox.'}
              </h1>
              <p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
                {stage === 'email'
                  ? 'Sign in or create your PFT account with a secure email code.'
                  : stage === 'password'
                    ? `Enter the password for ${email}.`
                    : `Enter the six-digit code sent to ${email}. It expires in 10 minutes.`}
              </p>
            </div>

            {stage === 'email' ? (
              <form onSubmit={(event) => void resolveMethod(event)} className="mt-9">
                <label htmlFor="auth-email" className="text-sm font-medium text-foreground">Email address</label>
                <input
                  id="auth-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  required
                  maxLength={254}
                  placeholder="you@example.com"
                  className={INPUT_CLASS}
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-bold text-primary-foreground shadow-[0_0_45px_-14px_rgba(67,136,255,0.9)] transition hover:brightness-110 hover:shadow-[0_0_45px_-10px_rgba(67,136,255,0.9)] disabled:cursor-wait disabled:opacity-60"
                >
                  {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
                  Continue with email <ArrowRight className="size-4" />
                </button>
              </form>
            ) : stage === 'password' ? (
              <form onSubmit={(event) => void signInWithPassword(event)} className="mt-9">
                <label htmlFor="auth-password" className="text-sm font-medium text-foreground">Password</label>
                <input
                  id="auth-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                  maxLength={200}
                  placeholder="Your password"
                  className={INPUT_CLASS}
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-bold text-primary-foreground shadow-[0_0_45px_-14px_rgba(67,136,255,0.9)] transition hover:brightness-110 hover:shadow-[0_0_45px_-10px_rgba(67,136,255,0.9)] disabled:cursor-wait disabled:opacity-60"
                >
                  {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
                  Sign in <ArrowRight className="size-4" />
                </button>
                <div className="mt-4 flex items-center justify-between text-xs">
                  <button type="button" onClick={() => { setStage('email'); setPassword(''); setError(null); setInfo(null) }} className="text-muted-foreground hover:text-white">
                    Change email
                  </button>
                  <button
                    type="button"
                    onClick={() => { setCodeFlow('login'); void requestCode() }}
                    disabled={busy || resendIn > 0}
                    className="text-primary hover:text-highlight disabled:opacity-50"
                  >
                    Sign in with an email code instead
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={(event) => void verifyCode(event)} className="mt-9">
                <label htmlFor="auth-code" className="text-sm font-medium text-foreground">Six-digit code</label>
                <input
                  id="auth-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  required
                  placeholder="000000"
                  className={`${INPUT_CLASS} text-center font-mono text-xl tracking-[0.45em]`}
                />
                <button
                  type="submit"
                  disabled={busy || code.length !== 6}
                  className="mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-bold text-primary-foreground shadow-[0_0_45px_-14px_rgba(67,136,255,0.9)] transition hover:brightness-110 hover:shadow-[0_0_45px_-10px_rgba(67,136,255,0.9)] disabled:cursor-wait disabled:opacity-60"
                >
                  {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
                  Verify and continue <ArrowRight className="size-4" />
                </button>
                <div className="mt-4 flex items-center justify-between text-xs">
                  <button type="button" onClick={() => { setStage('email'); setError(null); setInfo(null) }} className="text-muted-foreground hover:text-white">
                    Change email
                  </button>
                  <button
                    type="button"
                    onClick={() => (codeFlow === 'step-up' ? void resendStepUpCode() : void requestCode())}
                    disabled={busy || resendIn > 0}
                    className="text-primary hover:text-highlight disabled:opacity-50"
                  >
                    {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Send a new code'}
                  </button>
                </div>
              </form>
            )}

            {error && <p role="alert" className="mt-4 text-sm text-rose-400">{error}</p>}
            {info && <p role="status" className="mt-4 text-sm text-primary">{info}</p>}

            <div className="my-7 flex items-center gap-4 text-[10px] uppercase tracking-[0.2em] text-muted-foreground/60">
              <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
            </div>
            <button
              type="button"
              disabled={!googleEnabled || busy}
              onClick={() => void signIn('google', { redirectTo: '/api/auth/google/complete' })}
              className="inline-flex h-12 w-full items-center justify-center gap-3 rounded-lg border border-border bg-card/50 text-sm font-medium text-foreground transition hover:border-primary/50 hover:bg-primary/10 hover:shadow-[0_0_18px_-10px_rgba(67,136,255,0.8)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span aria-hidden="true" className="grid size-5 place-items-center rounded-full bg-white text-xs font-bold text-primary-foreground">G</span>
              Continue with Google
            </button>
            {!googleEnabled && <p className="mt-2 text-center text-xs text-muted-foreground/80">Google sign-in is not configured for this environment yet.</p>}

            <p className="mt-9 flex items-center justify-center gap-2 text-xs text-muted-foreground/80">
              <ShieldCheck className="size-4 text-primary" /> Secure access for traders
            </p>
          </div>
        </section>

        <aside className="relative hidden overflow-hidden border-l border-border/60 bg-card lg:flex lg:min-h-dvh lg:items-end">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_70%_28%,rgba(67,136,255,0.16),transparent_38%),radial-gradient(ellipse_at_15%_85%,rgba(85,214,232,0.08),transparent_40%),linear-gradient(145deg,#0d1526_0%,#080d1a_55%,#070b16_100%)]" />
          <div className="absolute inset-0 opacity-[0.12] [background-image:linear-gradient(rgba(255,255,255,.08)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.08)_1px,transparent_1px)] [background-size:72px_72px]" />
          <div className="relative z-10 max-w-2xl px-14 pb-16 xl:px-20 xl:pb-20">
            <div className="mb-8 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.25em] text-primary">
              <span className="size-2 rounded-full bg-primary shadow-[0_0_18px_rgba(67,136,255,.8)]" />
              Trade with a plan
            </div>
            <p className="text-5xl font-semibold leading-[1.08] tracking-tight text-white xl:text-6xl">
              Built for traders.
              <span className="block text-primary">Funded for growth.</span>
            </p>
            <p className="mt-6 max-w-lg text-base leading-7 text-muted-foreground">
              Clear objectives, transparent rules, and a professional trading environment designed around disciplined execution.
            </p>
            <div className="mt-12 flex items-center gap-3 text-sm text-muted-foreground">
              <span className="h-px w-10 bg-primary/60" /> Professional Funded Trader
            </div>
          </div>
          <div className="absolute top-[12%] right-[12%] size-72 xl:size-[26rem]">
            <KineticOrbit />
          </div>
        </aside>
      </div>
    </main>
  )
}
