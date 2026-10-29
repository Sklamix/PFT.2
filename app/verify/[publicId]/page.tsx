import type { Metadata } from 'next'
import Link from 'next/link'
import { ShieldCheck, ShieldOff, ShieldX } from 'lucide-react'
import { getPublicCertificate } from '@/lib/certificates/service'
import { renderCertificateSvg } from '@/lib/certificates/render'
import { formatIssueDate } from '@/lib/certificates/service'
import type { CertificateTheme, CertificateType } from '@/lib/certificates/types'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Certificate Verification — Professional Funded Trader',
  robots: { index: false },
}

export default async function VerifyPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params
  const cert = await getPublicCertificate(publicId)

  if (!cert) {
    return (
      <Shell>
        <StatusPill icon={<ShieldX className="size-4" />} tone="neutral" label="Certificate not found" />
        <h1 className="mt-5 text-xl font-semibold text-white">We could not verify this certificate</h1>
        <p className="mt-2 max-w-sm text-sm text-slate-400">
          The certificate <span className="font-mono text-slate-300">{publicId}</span> does not exist. Check the ID and
          try again.
        </p>
      </Shell>
    )
  }

  if (cert.status === 'REVOKED') {
    return (
      <Shell>
        <StatusPill icon={<ShieldOff className="size-4" />} tone="error" label="Revoked" />
        <h1 className="mt-5 text-xl font-semibold text-white">This certificate has been revoked</h1>
        <p className="mt-2 max-w-md text-sm text-slate-400">
          {cert.revokeReason ?? 'This certificate is no longer valid and should not be considered proof of achievement.'}
        </p>
        <p className="mt-4 font-mono text-xs text-slate-500">{publicId}</p>
      </Shell>
    )
  }

  const svg = await renderCertificateSvg({
    publicId: cert.publicId,
    type: cert.type as CertificateType,
    displayName: cert.displayName,
    accountLabel: cert.accountLabel,
    amountLabel: cert.amountLabel,
    issuedAt: formatIssueDate(new Date(cert.issuedAt)),
    theme: cert.theme as CertificateTheme,
    symbol: cert.symbol,
    status: 'VERIFIED',
  })

  return (
    <Shell wide>
      <div className="mb-6 flex flex-col items-center gap-3">
        <StatusPill icon={<ShieldCheck className="size-4" />} tone="success" label="Officially verified" />
        <p className="text-center text-sm text-slate-400">
          {cert.title} · <span className="font-mono text-slate-300">{cert.displayName}</span>
        </p>
      </div>
      <div className="certificate-svg w-full" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="mt-6 flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-xs text-slate-500">
        <span>
          Issued <span className="font-mono text-slate-400">{formatIssueDate(new Date(cert.issuedAt))}</span>
        </span>
        <span>
          Certificate ID <span className="font-mono text-slate-400">{cert.publicId}</span>
        </span>
      </div>
      <a
        href="/auth/login"
        className="mt-8 inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-emerald-500 px-6 text-sm font-semibold text-emerald-950 shadow-[0_0_28px_-10px_rgba(16,185,129,0.7)] transition hover:bg-emerald-400"
      >
        Want to achieve the same? Create Your Account
      </a>
    </Shell>
  )
}

function Shell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-[#04060e] px-4 py-12 text-foreground">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_-10%,rgba(37,99,235,0.16),transparent_55%)]" />
      <div className="pointer-events-none absolute inset-0 cosmic-stars opacity-50" />
      <div className={wide ? 'relative z-10 w-full max-w-3xl' : 'relative z-10 flex w-full max-w-md flex-col items-center rounded-2xl border border-white/10 bg-[#0b0f19]/80 p-8 text-center backdrop-blur-md'}>
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="flex h-8 items-center rounded-md bg-linear-to-br from-primary to-highlight p-px">
            <span className="flex h-full items-center rounded-[5px] bg-[#04060e] px-2 font-mono text-xs font-bold tracking-widest text-white">PFT</span>
          </span>
          <span className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">Professional Funded Trader</span>
        </div>
        {children}
      </div>
    </main>
  )
}

function StatusPill({ icon, label, tone }: { icon: React.ReactNode; label: string; tone: 'success' | 'error' | 'neutral' }) {
  const color = tone === 'success' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : tone === 'error' ? 'border-red-500/40 bg-red-500/10 text-red-300' : 'border-slate-600/40 bg-slate-700/20 text-slate-400'
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] ${color}`}>
      {icon}
      {label}
    </span>
  )
}
