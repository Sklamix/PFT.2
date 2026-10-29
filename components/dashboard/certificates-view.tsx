'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Download, ExternalLink, X } from 'lucide-react'
import { cn } from '@/lib/utils'

type CertificateSummary = {
  publicId: string
  type: string
  title: string
  status: string
  theme: string
  symbol: string | null
  displayNameMode: string
  hasKycName: boolean
  kycConsentGiven: boolean
  showAmount: boolean
  displayName: string
  accountLabel: string | null
  amountLabel: string | null
  issuedAt: string
}

const THEMES = [
  { id: 'GOLD', label: 'Gold' },
  { id: 'SILVER', label: 'Silver' },
  { id: 'NEBULA', label: 'Nebula Blue' },
] as const

const SYMBOLS = ['🪐', '🌙', '⭐', '🚀', '🌌', '☄️', '🛰️', '✨', '🌍', '🔥', '💫'] as const

const dateFmt = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

function downloadPng(publicId: string) {
  void (async () => {
    try {
      const res = await fetch(`/api/certificates/${encodeURIComponent(publicId)}/render`)
      if (!res.ok) return
      const svgText = await res.text()
      const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' })
      const url = URL.createObjectURL(svgBlob)
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = 1280
        canvas.height = 720
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.drawImage(img, 0, 0, 1280, 720)
        URL.revokeObjectURL(url)
        canvas.toBlob((blob) => {
          if (!blob) return
          const a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = `${publicId}.png`
          a.click()
        }, 'image/png')
      }
      img.onerror = () => URL.revokeObjectURL(url)
      img.src = url
    } catch {
      // Ignore download failures; the verify link remains available.
    }
  })()
}

function Customizer({
  cert,
  onClose,
  onSaved,
}: {
  cert: CertificateSummary
  onClose: () => void
  onSaved: () => void
}) {
  const [theme, setTheme] = useState(cert.theme)
  const [symbol, setSymbol] = useState<string | null>(cert.symbol)
  const [nameMode, setNameMode] = useState<'PROFILE' | 'KYC'>(cert.displayNameMode as 'PROFILE' | 'KYC')
  const [kycConsent, setKycConsent] = useState(cert.kycConsentGiven)
  const [showAmount, setShowAmount] = useState(cert.showAmount)
  const [svg, setSvg] = useState<string | null>(null)
  const [kycPending, setKycPending] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)

  const preview = useCallback(
    (payload: Record<string, unknown>) => {
      if (timer.current) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(async () => {
        try {
          const res = await fetch(`/api/certificates/${encodeURIComponent(cert.publicId)}/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
          const data = (await res.json()) as { svg?: string; kycPending?: boolean; error?: string }
          if (!res.ok) {
            setError(data.error ?? 'Unable to render preview')
            return
          }
          if (data.svg) setSvg(data.svg)
          setKycPending(Boolean(data.kycPending))
          setError(null)
        } catch {
          setError('Unable to render preview')
        }
      }, 180)
    },
    [cert.publicId],
  )

  useEffect(() => {
    preview({ theme, symbol, displayNameMode: nameMode, showAmount, kycConsent })
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [theme, symbol, nameMode, showAmount, kycConsent, preview])

  const verifyUrl = `${window.location.origin}/verify/${cert.publicId}`

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/certificates/${encodeURIComponent(cert.publicId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme, symbol, displayNameMode: nameMode, showAmount, kycConsent }),
      })
      const data = (await res.json()) as { error?: string }
      if (!res.ok) {
        setError(data.error ?? 'Unable to save')
        setSaving(false)
        return
      }
      setSaving(false)
      onSaved()
    } catch {
      setError('Unable to save')
      setSaving(false)
    }
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(verifyUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard unavailable.
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-[#0B0F19]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">{cert.title}</h3>
            <p className="font-mono text-xs text-slate-500">{cert.publicId}</p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-200" aria-label="Close">
            <X className="size-5" />
          </button>
        </div>

        <div className="grid flex-1 gap-5 overflow-y-auto p-5 lg:grid-cols-[1fr_280px]">
          {/* Preview */}
          <div className="min-w-0">
            <div className="certificate-svg overflow-hidden rounded-xl border border-slate-800">
              {svg ? <div dangerouslySetInnerHTML={{ __html: svg }} /> : <div className="aspect-video w-full bg-slate-900" />}
            </div>
            {kycPending ? (
              <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                Your legal name is not shown until you grant consent below.
              </p>
            ) : null}
          </div>

          {/* Controls */}
          <div className="flex flex-col gap-4 text-sm">
            <div>
              <p className="mb-2 text-[11px] uppercase tracking-[0.16em] text-slate-500">Trader name</p>
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-slate-200">
                  <input type="radio" checked={nameMode === 'PROFILE'} onChange={() => setNameMode('PROFILE')} />
                  Profile name
                </label>
                <label className={cn('flex items-start gap-2', cert.hasKycName ? 'text-slate-200' : 'cursor-not-allowed text-slate-600')}>
                  <input
                    type="radio"
                    checked={nameMode === 'KYC'}
                    disabled={!cert.hasKycName}
                    onChange={() => setNameMode('KYC')}
                  />
                  <span>
                    Full legal name (KYC)
                    {!cert.hasKycName && <span className="block text-[11px] text-slate-600">No verified legal name on file.</span>}
                  </span>
                </label>
                {nameMode === 'KYC' && cert.hasKycName ? (
                  <label className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                    <input type="checkbox" checked={kycConsent} onChange={(e) => setKycConsent(e.target.checked)} className="mr-2" />
                    I understand my legal name will be publicly visible on this certificate and its verification page.
                  </label>
                ) : null}
              </div>
            </div>

            <div>
              <p className="mb-2 text-[11px] uppercase tracking-[0.16em] text-slate-500">Theme</p>
              <div className="flex gap-1.5">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTheme(t.id)}
                    className={cn('h-8 rounded-md px-3 text-xs', theme === t.id ? 'bg-slate-800 text-slate-100' : 'border border-slate-800 text-slate-400 hover:text-slate-200')}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-2 text-[11px] uppercase tracking-[0.16em] text-slate-500">Personal symbol</p>
              <div className="flex flex-wrap gap-1.5">
                {SYMBOLS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSymbol(s)}
                    className={cn('grid size-8 place-items-center rounded-md border text-lg', symbol === s ? 'border-slate-400 bg-slate-800' : 'border-slate-800 hover:border-slate-600')}
                    aria-label={`Select ${s}`}
                  >
                    {s}
                  </button>
                ))}
                <button type="button" onClick={() => setSymbol(null)} className="h-8 rounded-md border border-slate-800 px-2 text-xs text-slate-400 hover:text-slate-200">
                  None
                </button>
              </div>
            </div>

            {cert.type === 'PAYOUT' ? (
              <div>
                <p className="mb-2 text-[11px] uppercase tracking-[0.16em] text-slate-500">Payout amount</p>
                <div className="flex gap-1.5">
                  <button type="button" onClick={() => setShowAmount(true)} className={cn('h-8 rounded-md px-3 text-xs', showAmount ? 'bg-slate-800 text-slate-100' : 'border border-slate-800 text-slate-400')}>
                    Show amount
                  </button>
                  <button type="button" onClick={() => setShowAmount(false)} className={cn('h-8 rounded-md px-3 text-xs', !showAmount ? 'bg-slate-800 text-slate-100' : 'border border-slate-800 text-slate-400')}>
                    Hide amount
                  </button>
                </div>
              </div>
            ) : null}

            {error ? <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p> : null}

            <div className="mt-auto flex flex-col gap-2 pt-2">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || (nameMode === 'KYC' && cert.hasKycName && !kycConsent)}
                className="h-9 rounded-md bg-emerald-500 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
              <div className="grid grid-cols-3 gap-2">
                <button type="button" onClick={() => downloadPng(cert.publicId)} className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-slate-800 text-xs text-slate-200 hover:border-slate-600">
                  <Download className="size-3.5" /> PNG
                </button>
                <button type="button" onClick={() => void copyLink()} className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-slate-800 text-xs text-slate-200 hover:border-slate-600">
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} Copy link
                </button>
                <a href={verifyUrl} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-slate-800 text-xs text-slate-200 hover:border-slate-600">
                  <ExternalLink className="size-3.5" /> Verify
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export function CertificatesView() {
  const [certs, setCerts] = useState<CertificateSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/certificates', { cache: 'no-store' })
      if (res.status === 401) {
        window.location.assign('/login?next=/dashboard/payouts')
        return
      }
      const data = (await res.json()) as { certificates?: CertificateSummary[] }
      if (Array.isArray(data.certificates)) setCerts(data.certificates)
    } catch {
      // Keep last snapshot.
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const open = useMemo(() => certs.find((c) => c.publicId === openId) ?? null, [certs, openId])

  return (
    <>
      {loading ? (
        <p className="py-10 text-center text-sm text-slate-500">Loading certificates…</p>
      ) : certs.length === 0 ? (
        <div className="rounded-xl border border-slate-800/80 bg-[#0B0F19]/80 p-10 text-center">
          <p className="text-sm text-slate-400">
            No certificates yet — complete an evaluation phase, get funded, or receive a payout to earn one.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {certs.map((cert) => (
            <button
              key={cert.publicId}
              type="button"
              onClick={() => setOpenId(cert.publicId)}
              className="group overflow-hidden rounded-xl border border-slate-800/80 bg-[#0B0F19]/80 text-left transition hover:border-slate-600"
            >
              <div className="certificate-svg overflow-hidden">
                <img src={`/api/certificates/${encodeURIComponent(cert.publicId)}/render`} alt={cert.title} className="block" />
              </div>
              <div className="flex items-center justify-between gap-2 px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-slate-100">{cert.title}</p>
                  <p className="text-xs text-slate-500">
                    {cert.displayName} · {dateFmt(cert.issuedAt)}
                  </p>
                </div>
                <span
                  className={cn(
                    'shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase',
                    cert.status === 'VERIFIED' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-red-500/40 bg-red-500/10 text-red-300',
                  )}
                >
                  {cert.status.toLowerCase()}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {open ? <Customizer cert={open} onClose={() => setOpenId(null)} onSaved={() => void load()} /> : null}
    </>
  )
}
