'use client'

import { useState } from 'react'
import { Check, Copy, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { Role } from '@/lib/admin/types'

type StaffRole = Exclude<Role, 'TRADER'>

type CreatedStaff = {
  user: { id: string; email: string; name: string; role: string }
  generatedPassword?: string
}

export function CreateStaffDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<StaffRole>('RISK_MANAGER')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<CreatedStaff | null>(null)
  const [copied, setCopied] = useState(false)

  function reset() {
    setEmail('')
    setName('')
    setRole('RISK_MANAGER')
    setPassword('')
    setError(null)
    setResult(null)
    setCopied(false)
  }

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/admin/staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name, role, password: password || undefined }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Unable to create staff account.')
      setResult(data)
      onCreated()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to create staff account.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value)
        if (!value) reset()
      }}
    >
      <DialogContent className="border-border bg-card sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="size-4 text-muted-foreground" aria-hidden="true" />
            Add staff member
          </DialogTitle>
          <DialogDescription>
            Create an administrator or risk manager. Leave the password blank to generate a strong one.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            <p className="text-sm text-foreground">
              Created <strong>{result.user.role}</strong> {result.user.email}.
            </p>
            {result.generatedPassword ? (
              <div className="rounded-md border border-border bg-secondary/20 p-3">
                <p className="text-xs text-muted-foreground">Generated password — shown once, copy it now:</p>
                <div className="mt-1.5 flex items-center gap-2">
                  <code className="flex-1 rounded bg-background px-2 py-1.5 font-mono text-sm break-all">
                    {result.generatedPassword}
                  </code>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      void navigator.clipboard?.writeText(result.generatedPassword ?? '')
                      setCopied(true)
                    }}
                  >
                    {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
              </div>
            ) : null}
            <DialogFooter>
              <Button onClick={reset}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <label className="block text-xs text-muted-foreground">
              Email
              <input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-lime-300/60"
                placeholder="staff@example.com"
                autoComplete="off"
              />
            </label>
            <label className="block text-xs text-muted-foreground">
              Full name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-lime-300/60"
                placeholder="Jane Doe"
                autoComplete="off"
              />
            </label>
            <label className="block text-xs text-muted-foreground">
              Role
              <select
                value={role}
                onChange={(event) => setRole(event.target.value as StaffRole)}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
              >
                <option value="RISK_MANAGER">Risk manager</option>
                <option value="ADMIN">Administrator</option>
              </select>
            </label>
            <label className="block text-xs text-muted-foreground">
              Password (optional — auto-generated if blank)
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-lime-300/60"
                placeholder="Leave blank to generate"
                autoComplete="new-password"
              />
            </label>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter>
              <Button disabled={busy || !email.trim() || !name.trim()} onClick={() => void submit()}>
                {busy ? 'Creating…' : 'Create staff'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
