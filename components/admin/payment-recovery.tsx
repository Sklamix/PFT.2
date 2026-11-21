'use client'

import { useCallback, useEffect, useState } from 'react'

type RecoveryItem = {
  orderId: string
  providerOrderId: string
  orderStatus: string
  user: { id: string; email: string; name: string | null }
  amount: string
  currency: string
  paidAt: string
  status: string
  reason: string | null
  errorCode: string | null
  attempts: number
  maxAttempts: number
  lastAttemptAt: string | null
  nextAttemptAt: string | null
  lastError: string | null
  accountId: string | null
  actions: string[]
}

export function PaymentRecoveryPanel() {
  const [items, setItems] = useState<RecoveryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/payment-recovery', { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.error ?? 'Could not load recovery queue')
      setItems(Array.isArray(data.items) ? data.items : [])
      setMessage(null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not load recovery queue')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Defer the initial fetch out of the effect body so React does not treat loading
    // state as a synchronous cascading render.
    const timer = setTimeout(() => {
      void load()
    }, 0)
    return () => clearTimeout(timer)
  }, [load])

  async function retry(orderId: string) {
    setBusy(orderId)
    try {
      const response = await fetch(`/api/admin/payment-recovery/${orderId}/retry`, { method: 'POST' })
      const data = await response.json().catch(() => ({}))
      setMessage(response.ok ? `Recovered: ${data.status}` : (data?.error ?? 'Retry failed'))
      await load()
    } finally {
      setBusy(null)
    }
  }

  async function review(orderId: string, status: 'MANUAL_REVIEW' | 'REFUND_REVIEW') {
    const note = window.prompt('Review note (required):')
    if (!note) return
    setBusy(orderId)
    try {
      const response = await fetch(`/api/admin/payment-recovery/${orderId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, note }),
      })
      const data = await response.json().catch(() => ({}))
      setMessage(response.ok ? `Marked ${status}. No money was moved.` : (data?.error ?? 'Review update failed'))
      await load()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Payment Recovery</h1>
          <p className="text-sm text-muted-foreground">
            Paid orders without a trading account. Retrying never moves money.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setLoading(true)
            void load()
          }}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
        >
          Refresh
        </button>
      </div>

      {message ? <p className="mb-3 rounded-md border border-border p-2 text-sm">{message}</p> : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

      <div className="space-y-3">
        {items.map((item) => (
          <div key={item.orderId} className="rounded-lg border border-border p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <p className="font-medium">{item.providerOrderId}</p>
                <p className="text-sm text-muted-foreground">
                  {item.user.email} · {item.amount} {item.currency} · paid {new Date(item.paidAt).toLocaleString()}
                </p>
              </div>
              <span className="rounded-full border border-border px-2 py-0.5 text-xs">{item.status}</span>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-4">
              <div><dt className="text-muted-foreground">Provisioning</dt><dd>{item.orderStatus}</dd></div>
              <div><dt className="text-muted-foreground">Attempts</dt><dd>{item.attempts}/{item.maxAttempts}</dd></div>
              <div><dt className="text-muted-foreground">Last attempt</dt><dd>{item.lastAttemptAt ? new Date(item.lastAttemptAt).toLocaleString() : '—'}</dd></div>
              <div><dt className="text-muted-foreground">Account</dt><dd>{item.accountId ?? '—'}</dd></div>
            </dl>
            {item.errorCode || item.lastError ? (
              <p className="mt-2 text-sm">
                <span className="text-muted-foreground">{item.errorCode ?? 'Error'}:</span> {item.lastError ?? item.reason}
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {item.actions.includes('RETRY') ? (
                <button
                  type="button"
                  disabled={busy === item.orderId}
                  onClick={() => void retry(item.orderId)}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
                >
                  Retry provisioning
                </button>
              ) : null}
              {item.actions.includes('MANUAL_REVIEW') ? (
                <button
                  type="button"
                  disabled={busy === item.orderId}
                  onClick={() => void review(item.orderId, 'MANUAL_REVIEW')}
                  className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
                >
                  Mark manual review
                </button>
              ) : null}
              {item.actions.includes('REFUND_REVIEW') ? (
                <button
                  type="button"
                  disabled={busy === item.orderId}
                  onClick={() => void review(item.orderId, 'REFUND_REVIEW')}
                  className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
                >
                  Send to refund review
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {!loading && items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No paid orders need recovery.</p>
      ) : null}
    </div>
  )
}
