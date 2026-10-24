'use client'

import { useEffect, useState } from 'react'
import { BadgeCheck, LoaderCircle, RotateCcw, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

type KycStatus = 'NOT_STARTED' | 'PENDING' | 'APPROVED' | 'REJECTED'
type ChallengeStatus = 'IN_PROGRESS' | 'PASSED' | 'FAILED'

type AdminKyc = {
  userId: string
  name: string
  email: string
  kycStatus: KycStatus
  kycSessionId: string | null
  kycVerifiedAt: string | null
  kycNote: string | null
  kycUpdatedAt: string | null
  challengeStatus: ChallengeStatus
}

const STATUS_STYLE: Record<KycStatus, string> = {
  NOT_STARTED: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
  PENDING: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
  APPROVED: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
  REJECTED: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
}

function date(value: string | null) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function KycDialog({
  open,
  onOpenChange,
  userId,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  userId: string | null
  onSaved?: () => void
}) {
  const [record, setRecord] = useState<AdminKyc | null>(null)
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !userId) return
    let active = true
    setLoading(true)
    setError(null)
    fetch(`/api/admin/kyc?userId=${encodeURIComponent(userId)}`, { cache: 'no-store' })
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as { kyc?: AdminKyc; error?: string }
        if (!response.ok || !data.kyc) throw new Error(data.error || 'Unable to load KYC record.')
        if (!active) return
        setRecord(data.kyc)
        setNote(data.kyc.kycNote ?? '')
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Unable to load KYC record.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [open, userId])

  async function act(action: 'approve' | 'reject' | 'reset') {
    if (!record) return
    if (action === 'reset' && !window.confirm('Reset this verification? The trader will be able to start KYC again.')) return
    setBusy(action)
    setError(null)
    try {
      const response = await fetch('/api/admin/kyc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: record.userId, action, note }),
      })
      const data = (await response.json().catch(() => ({}))) as { kyc?: AdminKyc; error?: string }
      if (!response.ok || !data.kyc) throw new Error(data.error || 'KYC update failed.')
      setRecord(data.kyc)
      setNote(data.kyc.kycNote ?? '')
      onSaved?.()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'KYC update failed.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-card sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-primary" /> KYC verification
          </DialogTitle>
          <DialogDescription>
            {record ? `${record.name} · ${record.email}` : 'Loading trader KYC record…'}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" /> Loading KYC record…
          </div>
        ) : record ? (
          <div className="space-y-4">
            <div className="grid gap-3 rounded-lg border border-border bg-background/50 p-3 text-xs sm:grid-cols-2">
              <div>
                <p className="text-muted-foreground">KYC status</p>
                <span className={cn('mt-1 inline-flex rounded-full border px-2 py-0.5 font-semibold', STATUS_STYLE[record.kycStatus])}>
                  {record.kycStatus}
                </span>
              </div>
              <div>
                <p className="text-muted-foreground">Challenge</p>
                <p className="mt-1 font-semibold text-foreground">{record.challengeStatus}</p>
              </div>
              <div className="sm:col-span-2">
                <p className="text-muted-foreground">Didit session</p>
                <p className="mt-1 break-all font-mono text-[11px] text-foreground">{record.kycSessionId ?? '—'}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Verified at</p>
                <p className="mt-1 text-foreground">{date(record.kycVerifiedAt)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Last KYC update</p>
                <p className="mt-1 text-foreground">{date(record.kycUpdatedAt)}</p>
              </div>
            </div>

            {record.challengeStatus !== 'PASSED' && (
              <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                Challenge gate is closed for this trader. Manual approval can still override KYC.
              </p>
            )}

            <label className="block text-xs font-medium text-muted-foreground">
              Admin note / rejection reason
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={1000}
                className="mt-1.5 min-h-24 w-full rounded-md border border-border bg-background p-2 text-sm text-foreground"
                placeholder="Reason or internal note for this KYC decision"
              />
            </label>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={Boolean(busy)} onClick={() => void act('approve')}>
                {busy === 'approve' ? <LoaderCircle className="animate-spin" /> : <BadgeCheck />}
                Approve manually
              </Button>
              <Button size="sm" variant="destructive" disabled={Boolean(busy)} onClick={() => void act('reject')}>
                {busy === 'reject' ? <LoaderCircle className="animate-spin" /> : <ShieldAlert />}
                Reject manually
              </Button>
              <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void act('reset')}>
                {busy === 'reset' ? <LoaderCircle className="animate-spin" /> : <RotateCcw />}
                Reset verification
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-destructive">{error ?? 'KYC record not found.'}</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
