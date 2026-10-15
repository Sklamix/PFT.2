'use client'

import { FormEvent, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AuthCard, AuthField, safeNextPath } from '@/components/auth/AuthCard'
import { Button } from '@/components/ui/button'

export default function TraderLoginPage() {
  const router = useRouter()
  const [mode, setMode] = useState<'login' | 'forgot'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const response = await fetch(mode === 'login' ? '/api/auth/login' : '/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'login' ? { email, password } : { email }),
      })
      const data = (await response.json().catch(() => ({}))) as { error?: string; message?: string }
      if (!response.ok) throw new Error(data.error || 'Request failed')
      if (mode === 'forgot') {
        setInfo(data.message ?? 'Check your inbox for a reset link.')
        return
      }
      router.replace(safeNextPath())
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthCard
      title={mode === 'login' ? 'Trader login' : 'Reset password'}
      subtitle={
        mode === 'login'
          ? 'Sign in to open your trading terminal and challenge dashboard.'
          : 'Enter your account email and we will send you a link to choose a new password.'
      }
    >
      <form onSubmit={onSubmit}>
        <AuthField label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
        {mode === 'login' && (
          <AuthField label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
        )}
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        {info && <p className="mt-3 text-sm text-primary">{info}</p>}
        <Button type="submit" className="mt-5 w-full" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Send reset link'}
        </Button>
      </form>
      <button
        type="button"
        className="mt-4 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        onClick={() => {
          setMode(mode === 'login' ? 'forgot' : 'login')
          setError(null)
          setInfo(null)
        }}
      >
        {mode === 'login' ? 'Forgot your password or never set one?' : 'Back to sign in'}
      </button>
    </AuthCard>
  )
}
