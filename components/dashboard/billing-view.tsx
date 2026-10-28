'use client'

import { useEffect, type ReactNode } from 'react'
import { Download, Plus, ReceiptText, Wallet, X } from 'lucide-react'
import { useBilling, type BillingOrder } from '@/lib/stores/useBilling'
import { SpaceBackground } from './space-background'
import { cn } from '@/lib/utils'

const CARD = '#0B0F19'
const LABEL = '#94A3B8'
const GREEN = '#22C55E'
const RED = '#EF4444'

const usd = (n: number) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const dateFmt = (t: number) =>
  new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

const STATUS: Record<BillingOrder['status'], { color: string; label: string }> = {
  PENDING: { color: LABEL, label: 'Pending' },
  PAID: { color: GREEN, label: 'Paid' },
  FAILED: { color: RED, label: 'Failed' },
  EXPIRED: { color: LABEL, label: 'Expired' },
  REFUNDED: { color: LABEL, label: 'Refunded' },
}

function Card({ title, children, className = '' }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-xl border border-slate-800/80 bg-[#0B0F19]/80 p-5 backdrop-blur-md', className)}>
      {title ? (
        <h2 className="mb-4 text-[11px] font-medium uppercase tracking-[0.18em] text-[#94A3B8]">{title}</h2>
      ) : null}
      {children}
    </section>
  )
}

function InvoiceModal({ order, onClose }: { order: BillingOrder; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-slate-800/80 p-8"
        style={{ backgroundColor: CARD }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-[#94A3B8]">Receipt</p>
            <h3 className="mt-2 font-mono text-sm text-slate-100">#{order.id.slice(-10).toUpperCase()}</h3>
          </div>
          <button type="button" onClick={onClose} className="text-xs text-[#94A3B8] hover:text-slate-200" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <dl className="mt-6 space-y-3 text-sm">
          {(
            [
              ['Package', order.label],
              ['Amount', usd(order.amount)],
              ['Method', order.provider],
              ['Date', dateFmt(order.paidAt ?? order.createdAt)],
              ['Status', STATUS[order.status].label],
              ...(order.accountDisplayId ? [['Account', `#${order.accountDisplayId}`]] : []),
              ...(order.invoiceId ? [['Provider invoice', order.invoiceId.slice(0, 24)]] : []),
            ] as [string, string][]
          ).map(([term, value]) => (
            <div key={term} className="flex items-center justify-between gap-3 border-b border-slate-800/60 pb-2">
              <dt className="text-[#94A3B8]">{term}</dt>
              <dd className="font-mono text-xs text-slate-200">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.2em] text-slate-600">Professional Funded Trader</p>
        <div className="mt-6 flex gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-md border border-slate-800 px-4 text-xs text-slate-200 hover:border-slate-600"
          >
            <Download className="size-3.5" /> Download PDF
          </button>
          <button type="button" onClick={onClose} className="h-9 rounded-md px-4 text-xs text-[#94A3B8] hover:text-slate-200">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

export function BillingView() {
  const data = useBilling((state) => state.data)
  const loadState = useBilling((state) => state.loadState)
  const error = useBilling((state) => state.error)
  const invoiceId = useBilling((state) => state.invoiceId)
  const load = useBilling((state) => state.load)
  const setInvoice = useBilling((state) => state.setInvoice)

  useEffect(() => {
    void load()
    // Checkout sync: a new order placed in the challenge checkout appears here on the next poll.
    const timer = window.setInterval(() => void load(), 10_000)
    return () => window.clearInterval(timer)
  }, [load])

  const orders = data?.orders ?? []
  const invoiceOrder = orders.find((order) => order.id === invoiceId) ?? null

  return (
    <div className="min-h-dvh">
      <SpaceBackground />
      <div className="relative z-10 mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Header */}
        <header>
          <h1 className="text-lg font-semibold tracking-tight text-slate-100">Billing &amp; Orders</h1>
          <p className="mt-0.5 text-sm text-[#94A3B8]">
            Challenge purchases, crypto payment history and downloadable receipts.
          </p>
        </header>

        {/* Orders table */}
        <div className="mt-6">
          <Card title="Order History">
            {loadState === 'error' ? (
              <p className="text-sm text-[#94A3B8]">{error ?? 'Unable to load billing.'}</p>
            ) : loadState !== 'ready' ? (
              <p className="text-sm text-[#94A3B8]">Loading orders…</p>
            ) : orders.length === 0 ? (
              <p className="text-sm text-[#94A3B8]">No orders yet — buy a challenge to see it here.</p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800/80 text-[10px] uppercase tracking-[0.16em] text-[#94A3B8]">
                    <th className="py-2 pr-4 font-medium">Order ID</th>
                    <th className="py-2 pr-4 font-medium">Package</th>
                    <th className="py-2 pr-4 font-medium">Amount</th>
                    <th className="py-2 pr-4 font-medium">Gateway</th>
                    <th className="py-2 pr-4 font-medium">Date</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 text-right font-medium">Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => {
                    const tone = STATUS[order.status]
                    return (
                      <tr key={order.id} className="border-b border-slate-800/40 last:border-0">
                        <td className="py-2.5 pr-4 font-mono text-slate-200">#{order.id.slice(-10).toUpperCase()}</td>
                        <td className="py-2.5 pr-4 text-slate-200">{order.label}</td>
                        <td className="py-2.5 pr-4 font-mono tabular-nums text-slate-100">{usd(order.amount)}</td>
                        <td className="py-2.5 pr-4 font-mono text-[#94A3B8]">{order.provider}</td>
                        <td className="py-2.5 pr-4 font-mono tabular-nums text-[#94A3B8]">{dateFmt(order.createdAt)}</td>
                        <td className="py-2.5 pr-4 font-mono uppercase" style={{ color: tone.color }}>
                          {tone.label}
                        </td>
                        <td className="py-2.5 text-right">
                          <button
                            type="button"
                            onClick={() => setInvoice(order.id)}
                            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-800 px-2.5 text-[11px] text-slate-300 hover:border-slate-600 hover:text-slate-100"
                          >
                            <Download className="size-3" /> Receipt
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        {/* Payment methods / credits */}
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Card title="Store Credits">
            <div className="flex items-center gap-3">
              <Wallet className="size-5 text-[#94A3B8]" />
              <div>
                <p className="font-mono text-xl font-semibold tabular-nums text-slate-100">$0.00</p>
                <p className="mt-0.5 text-[11px] text-[#94A3B8]">
                  No store credits on this account. Refunds arrive here as credits first.
                </p>
              </div>
            </div>
          </Card>
          <Card title="Payment Methods">
            <div className="flex items-center gap-3">
              <ReceiptText className="size-5 text-[#94A3B8]" />
              <div>
                <p className="text-sm text-slate-100">Crypto only · USDT</p>
                <p className="mt-0.5 text-[11px] text-[#94A3B8]">
                  Payments are processed in USDT (TRC-20 / ERC-20) via our crypto gateways. Payouts go to your verified
                  wallet set on the Payouts page.
                </p>
              </div>
            </div>
            <a
              href="/dashboard/payouts"
              className="mt-4 inline-flex h-8 items-center gap-2 rounded-md border border-slate-800 px-3 text-xs text-slate-200 hover:border-slate-600"
            >
              <Plus className="size-3.5" /> Manage payout wallet
            </a>
          </Card>
        </div>
      </div>

      {invoiceOrder ? <InvoiceModal order={invoiceOrder} onClose={() => setInvoice(null)} /> : null}
    </div>
  )
}
