'use client'

import { useState } from 'react'
import { Check, Copy, Eye, EyeOff, ShieldAlert } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { TradingAccount } from '@/lib/dashboard-data'

type CredentialsDialogProps = {
  account: TradingAccount
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CredentialsDialog({ account, open, onOpenChange }: CredentialsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-card sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono tracking-tight">MT5 Login Credentials</DialogTitle>
          <DialogDescription>
            Use these details to connect {account.id} in MetaTrader 5. Never share them with anyone.
          </DialogDescription>
        </DialogHeader>
        <div key={account.id} className="flex flex-col gap-2.5">
          <CredentialRow label="Login" value={account.login} />
          <CredentialRow label="Password" value={account.password} secret />
          <CredentialRow label="Server" value={account.server} />
        </div>
        <p className="flex items-start gap-2 rounded-md border border-warning/25 bg-warning/10 p-2.5 text-xs leading-relaxed text-warning">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          PFT staff will never ask for your trading password. Reset it from Settings if you suspect exposure.
        </p>
      </DialogContent>
    </Dialog>
  )
}

function CredentialRow({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false)
  const [revealed, setRevealed] = useState(!secret)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</p>
        <p className="truncate font-mono text-sm text-foreground">{revealed ? value : '•'.repeat(value.length)}</p>
      </div>
      {secret && (
        <button
          type="button"
          onClick={() => setRevealed((state) => !state)}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
        >
          {revealed ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
        </button>
      )}
      <button
        type="button"
        onClick={copy}
        className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
        aria-label={`Copy ${label}`}
      >
        {copied ? <Check className="size-3.5 text-primary" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
        <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  )
}
