'use client'

import { FormEvent, useState } from 'react'
import { useRouter } from 'next/navigation'
import { BrandLogo } from '@/components/brand-logo'
import { Button } from '@/components/ui/button'

export default function AdminLoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('ops@pft.local')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/admin/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Login failed')
      router.replace('/admin')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#090D16] px-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm rounded-xl border border-border bg-[#0F172A] p-6 shadow-[0_0_40px_-20px] shadow-primary/40">
        <BrandLogo href="/" />
        <h1 className="mt-5 text-lg font-semibold tracking-tight">Operations Desk</h1>
        <p className="mt-1 text-sm text-muted-foreground">Staff access only. Trader portal remains at /dashboard.</p>
        <label className="mt-5 block text-xs text-muted-foreground">
          Email
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
            required
          />
        </label>
        <label className="mt-3 block text-xs text-muted-foreground">
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
            required
          />
        </label>
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        <Button type="submit" className="mt-5 w-full" disabled={busy}>
          {busy ? 'Authenticating…' : 'Enter desk'}
        </Button>
        <p className="mt-4 font-mono text-[11px] text-muted-foreground">
          Mock desk: ops@pft.local / PFT-Admin-Desk!
        </p>
      </form>
    </div>
  )
}
