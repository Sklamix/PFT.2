'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Award, Download, Eye, Plus, X } from 'lucide-react'
import { usePayouts, type CertificateCard, type PayoutRow } from '@/lib/stores/usePayouts'
import { SpaceBackground } from './space-background'
import { cn } from '@/lib/utils'

const BG = '#080C14'
const CARD = '#0C1220'
const LABEL = '#94A3B8'
const GREEN = '#22C55E'
const RED = '#EF4444'

const usd = (n: number) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const STATUS_TONE: Record<PayoutRow['status'], { color: string; label: string }> = {
  PENDING: { color: LABEL, label: 'Pending' },
  APPROVED: { color: LABEL, label: 'Processing' },
  DISBURSED: { color: GREEN, label: 'Paid' },
  REJECTED: { color: RED, label: 'Rejected' },
}

const dateFmt = (t: number) =>
  new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

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

function countdown(target: number | null): string {
  if (target == null) return '—'
  const diff = target - Date.now()
  if (diff <= 0) return 'Eligible now'
  const days = Math.floor(diff / 86_400_000)
  const hours = Math.floor((diff % 86_400_000) / 3_600_000)
  const minutes = Math.floor((diff % 3_600_000) / 60_000)
  return `${days}d ${hours}h ${minutes}m`
}

function RequestPayoutModal({ onClose, onSubmitted }: { onClose: () => void; onSubmitted: () => void }) {
  const data = usePayouts((state) => state.data)
  const [accountId, setAccountId] = useState('')
  const [amount, setAmount] = useState('')
  const [network, setNetwork] = useState<'USDT_TRC20' | 'USDT_ERC20'>('USDT_TRC20')
  const [walletAddress, setWalletAddress] = useState('')
  const [submitState, setSubmitState] = useState<'idle' | 'submitting'>('idle')
  const [formError, setFormError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const funded = data?.fundedAccounts ?? []
  const selected = funded.find((account) => account.id === accountId) ?? funded[0]

  const submit = async () => {
    if (!selected) return
    setSubmitState('submitting')
    setFormError(null)
    try {
      const response = await fetch('/api/payouts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selected.id, amount, network, walletAddress }),
      })
      const body = (await response.json().catch(() => null)) as { error?: string } | null
      if (!response.ok) {
        setFormError(body?.error ?? 'Payout request rejected.')
        setSubmitState('idle')
        return
      }
      setSuccess('Payout request submitted. It will appear as Pending until an operator approves it.')
      setSubmitState('idle')
      onSubmitted()
    } catch {
      setFormError('Network error. Try again.')
      setSubmitState('idle')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={success ? onClose : undefined}>
      <div
        className="w-full max-w-md rounded-xl border border-slate-800/80 p-6"
        style={{ backgroundColor: CARD }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-100">Request payout</h3>
          <button type="button" onClick={onClose} className="text-xs text-[#94A3B8] hover:text-slate-200" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>

        {success ? (
          <div>
            <p className="mt-4 rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs" style={{ color: GREEN }}>
              {success}
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-4 h-9 w-full rounded-md border border-slate-800 text-xs text-slate-200 hover:border-slate-600"
            >
              Done
            </button>
          </div>
        ) : funded.length === 0 ? (
          <p className="mt-4 text-xs text-[#94A3B8]">
            Payouts are available on Funded accounts only. Pass your evaluation to unlock withdrawals.
          </p>
        ) : (
          <div className="mt-5 space-y-4">
            <label className="block">
              <span className="text-[11px] uppercase tracking-[0.16em] text-[#94A3B8]">Funded account</span>
              <select
                value={selected?.id ?? ''}
                onChange={(event) => setAccountId(event.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-slate-800 bg-[#080C14] px-3 font-mono text-xs text-slate-200 outline-none focus:border-slate-600"
              >
                {funded.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.displayId} — available {usd(account.available)}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-[11px] uppercase tracking-[0.16em] text-[#94A3B8]">
                Amount (available {usd(selected?.available ?? 0)})
              </span>
              <input
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                className="mt-1 h-9 w-full rounded-md border border-slate-800 bg-[#080C14] px-3 font-mono text-xs tabular-nums text-slate-200 outline-none focus:border-slate-600"
              />
            </label>

            <label className="block">
              <span className="text-[11px] uppercase tracking-[0.16em] text-[#94A3B8]">Network</span>
              <select
                value={network}
                onChange={(event) => setNetwork(event.target.value as 'USDT_TRC20' | 'USDT_ERC20')}
                className="mt-1 h-9 w-full rounded-md border border-slate-800 bg-[#080C14] px-3 font-mono text-xs text-slate-200 outline-none focus:border-slate-600"
              >
                <option value="USDT_TRC20">USDT · TRC-20</option>
                <option value="USDT_ERC20">USDT · ERC-20</option>
              </select>
            </label>

            <label className="block">
              <span className="text-[11px] uppercase tracking-[0.16em] text-[#94A3B8]">Wallet address</span>
              <input
                value={walletAddress}
                onChange={(event) => setWalletAddress(event.target.value)}
                placeholder={network === 'USDT_TRC20' ? 'T…' : '0x…'}
                className="mt-1 h-9 w-full rounded-md border border-slate-800 bg-[#080C14] px-3 font-mono text-xs text-slate-200 outline-none focus:border-slate-600"
              />
            </label>

            {formError ? (
              <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs" style={{ color: RED }}>
                {formError}
              </p>
            ) : null}

            <button
              type="button"
              disabled={submitState === 'submitting' || !amount || !walletAddress}
              onClick={() => void submit()}
              className="h-9 w-full rounded-md border border-slate-600 text-xs text-slate-100 transition-colors hover:bg-slate-800/60 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitState === 'submitting' ? 'Submitting…' : 'Submit payout request'}
            </button>
            <p className="text-[10px] leading-relaxed text-slate-600">
              Withdrawals are processed in USDT via crypto transfer. Requests are reviewed by an operator before
              disbursement; the amount is reserved from your balance immediately.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function CertificatePreviewModal({ certificate, onClose }: { certificate: CertificateCard; onClose: () => void }) {
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
        className="w-full max-w-lg rounded-xl border border-slate-800/80 p-8 text-center"
        style={{ backgroundColor: CARD }}
        onClick={(event) => event.stopPropagation()}
      >
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-[#94A3B8]">Professional Funded Trader</p>
        <h3 className="mt-6 text-lg font-semibold text-slate-100">{certificate.title}</h3>
        <p className="mt-2 text-xs text-[#94A3B8]">Awarded to account</p>
        <p className="mt-1 font-mono text-sm text-slate-100">#{certificate.displayId}</p>
        <p className="mt-6 font-mono text-3xl font-semibold tabular-nums text-slate-100">
          ${(certificate.planSize / 1000).toFixed(0)}k
        </p>
        <p className="mt-2 text-xs text-[#94A3B8]">Issued {dateFmt(certificate.issuedAt)}</p>
        <p className="mt-6 font-mono text-[10px] uppercase tracking-[0.2em] text-slate-600">PFT · Rules v1.6</p>
        <div className="mt-6 flex justify-center gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-800 px-4 text-xs text-slate-200 hover:border-slate-600"
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

export function PayoutsView() {
  const data = usePayouts((state) => state.data)
  const loadState = usePayouts((state) => state.loadState)
  const error = usePayouts((state) => state.error)
  const tab = usePayouts((state) => state.tab)
  const requestOpen = usePayouts((state) => state.requestOpen)
  const previewId = usePayouts((state) => state.previewId)
  const load = usePayouts((state) => state.load)
  const setTab = usePayouts((state) => state.setTab)
  const setRequestOpen = usePayouts((state) => state.setRequestOpen)
  const setPreview = usePayouts((state) => state.setPreview)

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 10_000)
    return () => window.clearInterval(timer)
  }, [load])

  const payouts = data?.payouts ?? []
  const certificates = useMemo(() => data?.certificates ?? [], [data])
  const preview = certificates.find((certificate) => certificate.id === previewId) ?? null
  const nextEligible = data?.fundedAccounts
    ?.map((account) => account.eligibleAt)
    .filter((t): t is number => t != null)
    .sort((a, b) => a - b)[0] ?? null

  return (
    <div className="min-h-dvh">
      <SpaceBackground />
      <div className="relative z-10 mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Header + tabs */}
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-slate-100">Payouts &amp; Certificates</h1>
            <nav className="mt-3 flex items-center gap-1" aria-label="Payout sections">
              {(
                [
                  ['payouts', 'Payouts'],
                  ['certificates', 'Certificates'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  aria-pressed={tab === id}
                  className={cn(
                    'h-8 rounded-md px-3 text-xs transition-colors',
                    tab === id ? 'bg-slate-800/60 text-slate-100' : 'text-[#94A3B8] hover:text-slate-200',
                  )}
                >
                  {label}
                </button>
              ))}
            </nav>
          </div>
          {tab === 'payouts' ? (
            <button
              type="button"
              onClick={() => setRequestOpen(true)}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-600 px-4 text-sm text-slate-100 transition-colors hover:bg-slate-800/60"
            >
              <Plus className="size-4" /> Request Payout
            </button>
          ) : null}
        </header>

        {loadState === 'error' ? (
          <p className="mt-8 text-sm text-[#94A3B8]">{error ?? 'Unable to load payouts.'}</p>
        ) : loadState !== 'ready' ? (
          <p className="mt-8 text-sm text-[#94A3B8]">Loading…</p>
        ) : tab === 'payouts' ? (
          <>
            {/* Summary bar */}
            <div className="mt-6 grid gap-4 sm:grid-cols-3">
              <Card>
                <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#94A3B8]">Total Withdrawn</p>
                <p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-slate-100">{usd(data?.totals.withdrawn ?? 0)}</p>
              </Card>
              <Card>
                <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#94A3B8]">Available for Payout</p>
                <p className="mt-2 font-mono text-2xl font-semibold tabular-nums" style={{ color: GREEN }}>
                  {usd(data?.fundedAccounts.reduce((sum, account) => sum + account.available, 0) ?? 0)}
                </p>
              </Card>
              <Card>
                <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[#94A3B8]">Payout Eligibility</p>
                <p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-slate-100" suppressHydrationWarning>
                  {countdown(nextEligible)}
                </p>
                <p className="mt-1 text-[10px] text-slate-600">Next withdrawal window across your funded accounts</p>
              </Card>
            </div>

            {/* History table */}
            <div className="mt-6">
              <Card title="Payout History">
                {payouts.length === 0 ? (
                  <p className="text-sm text-[#94A3B8]">No payout requests yet.</p>
                ) : (
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-800/80 text-[10px] uppercase tracking-[0.16em] text-[#94A3B8]">
                        <th className="py-2 pr-4 font-medium">Payout ID</th>
                        <th className="py-2 pr-4 font-medium">Amount</th>
                        <th className="py-2 pr-4 font-medium">Asset / Method</th>
                        <th className="py-2 pr-4 font-medium">Date</th>
                        <th className="py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payouts.map((payout) => {
                        const tone = STATUS_TONE[payout.status]
                        return (
                          <tr key={payout.id} className="border-b border-slate-800/40 last:border-0">
                            <td className="py-2.5 pr-4 font-mono text-slate-200">{payout.id.slice(-8).toUpperCase()}</td>
                            <td className="py-2.5 pr-4 font-mono tabular-nums text-slate-100">{usd(payout.amount)}</td>
                            <td className="py-2.5 pr-4 font-mono text-[#94A3B8]">{payout.network}</td>
                            <td className="py-2.5 pr-4 font-mono tabular-nums text-[#94A3B8]">{dateFmt(payout.requestedAt)}</td>
                            <td className="py-2.5 font-mono uppercase" style={{ color: tone.color }}>
                              {tone.label}
                              {payout.status === 'REJECTED' && payout.rejectReason ? (
                                <span className="ml-2 normal-case opacity-70">{payout.rejectReason}</span>
                              ) : null}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </Card>
            </div>
          </>
        ) : (
          /* Certificates grid */
          certificates.length === 0 ? (
            <div className="mt-6 rounded-xl border border-slate-800/80 bg-[#0B0F19]/80 p-10 text-center backdrop-blur-md">
              <Award className="mx-auto size-6 text-[#94A3B8]" />
              <p className="mt-3 text-sm text-[#94A3B8]">
                No certificates yet — pass an evaluation phase or get funded to earn one.
              </p>
            </div>
          ) : (
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {certificates.map((certificate) => (
                <Card key={certificate.id}>
                  <div className="flex items-start justify-between gap-3">
                    <Award className="size-5" style={{ color: certificate.kind === 'FUNDED' ? GREEN : LABEL }} />
                    <span
                      className="rounded border border-slate-800 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide"
                      style={{ color: certificate.kind === 'FUNDED' ? GREEN : LABEL }}
                    >
                      {certificate.statusLabel}
                    </span>
                  </div>
                  <h3 className="mt-4 text-sm font-semibold text-slate-100">{certificate.title}</h3>
                  <p className="mt-1 font-mono text-xs text-[#94A3B8]">#{certificate.displayId}</p>
                  <p className="mt-3 font-mono text-2xl font-semibold tabular-nums text-slate-100">
                    ${(certificate.planSize / 1000).toFixed(0)}k
                  </p>
                  <p className="mt-1 font-mono text-[10px] text-slate-600">{dateFmt(certificate.issuedAt)}</p>
                  <div className="mt-4 flex gap-2">
                    <button
                      type="button"
                      onClick={() => setPreview(certificate.id)}
                      className="inline-flex h-8 flex-1 items-center justify-center gap-2 rounded-md border border-slate-800 px-3 text-xs text-slate-300 hover:border-slate-600 hover:text-slate-100"
                    >
                      <Eye className="size-3.5" /> View Certificate
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setPreview(certificate.id)
                      }}
                      className="inline-flex h-8 items-center justify-center gap-2 rounded-md border border-slate-800 px-3 text-xs text-slate-300 hover:border-slate-600 hover:text-slate-100"
                    >
                      <Download className="size-3.5" /> PDF
                    </button>
                  </div>
                </Card>
              ))}
            </div>
          )
        )}
      </div>

      {requestOpen ? (
        <RequestPayoutModal onClose={() => setRequestOpen(false)} onSubmitted={() => void load()} />
      ) : null}
      {preview ? <CertificatePreviewModal certificate={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  )
}
