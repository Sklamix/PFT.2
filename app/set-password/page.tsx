'use client'

import { FormEvent, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AuthCard, AuthField } from '@/components/auth/AuthCard'
import { Button } from '@/components/ui/button'

const MIN_PASSWORD_LENGTH = 8

export default function SetPasswordPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }
    setBusy(true)
    try {
      const token = new URLSearchParams(window.location.search).get('token') ?? ''
      const response = await fetch('/api/auth/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      })
      const data = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) throw new Error(data.error || 'Unable to set password')
      router.replace('/dashboard/terminal')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to set password')
      setBusy(false)
    }
  }

  return (
    <AuthCard title="Choose your password" subtitle="You will use your email and this password to sign in to the trading terminal.">
      <form onSubmit={onSubmit}>
        <AuthField label="New password" type="password" value={password} onChange={setPassword} autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} />
        <AuthField label="Confirm password" type="password" value={confirm} onChange={setConfirm} autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} />
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        <Button type="submit" className="mt-5 w-full" disabled={busy}>
          {busy ? 'Saving…' : 'Save password and open terminal'}
        </Button>
      </form>
      <Link href="/login" className="mt-4 inline-block text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
        Link expired? Request a new one
      </Link>
    </AuthCard>
  )
}
