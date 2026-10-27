'use client'

import { Award, Banknote, Download, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useNow } from '@/hooks/use-now'
import { formatDuration, formatUsd, getMetrics, nextPayoutAt, type TradingAccount } from '@/lib/dashboard-data'

function downloadCertificate(account: TradingAccount, profit: number) {
  const issued = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  const title = account.status === 'funded' ? 'FUNDED TRADER CERTIFICATE' : 'CERTIFICATE OF PASSING'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1130" viewBox="0 0 1600 1130">
  <defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#06b6d4"/><stop offset="1" stop-color="#10b981"/></linearGradient></defs>
  <rect width="1600" height="1130" fill="#090d16"/>
  <rect x="40" y="40" width="1520" height="1050" fill="none" stroke="url(#g)" stroke-width="4" rx="24"/>
  <text x="800" y="200" fill="#e2e8f0" font-family="monospace" font-size="40" font-weight="700" letter-spacing="12" text-anchor="middle">PFT // PROFESSIONAL FUNDED TRADER</text>
  <text x="800" y="330" fill="url(#g)" font-family="sans-serif" font-size="76" font-weight="700" text-anchor="middle">${title}</text>
  <text x="800" y="430" fill="#8a97ad" font-family="sans-serif" font-size="30" text-anchor="middle">This certifies that</text>
  <text x="800" y="530" fill="#e2e8f0" font-family="sans-serif" font-size="84" font-weight="600" text-anchor="middle">Marcus Reyes</text>
  <text x="800" y="630" fill="#8a97ad" font-family="sans-serif" font-size="30" text-anchor="middle">has met all trading objectives on account ${account.id}</text>
  <text x="800" y="680" fill="#8a97ad" font-family="sans-serif" font-size="30" text-anchor="middle">${formatUsd(account.size, { compact: true })} ${account.program} Evaluation · ${account.phase}</text>
  <text x="800" y="800" fill="#10b981" font-family="monospace" font-size="64" font-weight="700" text-anchor="middle">${formatUsd(profit, { signed: true })}</text>
  <text x="800" y="960" fill="#8a97ad" font-family="monospace" font-size="24" text-anchor="middle">Issued ${issued} · Verification ID ${account.login}</text>
</svg>`
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `PFT-certificate-${account.id}.svg`
  link.click()
  URL.revokeObjectURL(url)
}

export function PayoutCard({ account, onRequestPayout }: { account: TradingAccount; onRequestPayout: () => void }) {
  const now = useNow()
  const metrics = getMetrics(account)
  const isFunded = account.status === 'funded'
  const certificateAvailable = isFunded || metrics.targetPassed
  const countdown = now === null ? '-- -- --' : formatDuration(nextPayoutAt(now) - now, false)

  return (
    <section aria-labelledby="payout-title" className="relative flex flex-col gap-4 overflow-hidden rounded-xl border border-border bg-card p-5">
      <div className="pointer-events-none absolute -bottom-24 -right-16 size-56 rounded-full bg-primary/10 blur-3xl" aria-hidden="true" />
      <header className="relative flex items-center justify-between">
        <h2 id="payout-title" className="flex items-center gap-2 text-base font-semibold text-foreground">
          <Banknote className="size-4 text-primary" aria-hidden="true" />
          Payout Cycle
        </h2>
        <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Weekly</span>
      </header>

      {isFunded ? (
        <div className="relative rounded-lg border border-primary/25 bg-primary/5 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-primary">Eligible for disbursement in</p>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-foreground">{countdown}</p>
        </div>
      ) : (
        <div className="relative flex items-start gap-3 rounded-lg border border-border bg-background/60 p-4">
          <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm leading-relaxed text-muted-foreground">
            {account.status === 'breached'
              ? 'This account is closed. Payouts are unavailable after a hard breach.'
              : 'Payouts unlock on the Funded stage. Complete Phase 2 to start your weekly payout cycle.'}
          </p>
        </div>
      )}

      <dl className="relative grid grid-cols-2 gap-3 font-mono text-xs">
        <div>
          <dt className="text-muted-foreground">Revenue share</dt>
          <dd className="mt-0.5 text-lg font-semibold text-foreground">{account.profitSplit}%</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{isFunded ? 'Est. payout' : 'Projected share'}</dt>
          <dd className="mt-0.5 text-lg font-semibold text-primary tabular-nums">{formatUsd(metrics.traderShare, { compact: true })}</dd>
        </div>
      </dl>

      <div className="relative mt-auto flex flex-col gap-2">
        {isFunded && (
          <Button onClick={onRequestPayout}>
            <Banknote className="size-4" aria-hidden="true" />
            Request Payout
          </Button>
        )}
        <Button
          variant="outline"
          disabled={!certificateAvailable}
          onClick={() => downloadCertificate(account, metrics.profit)}
        >
          {certificateAvailable ? <Download className="size-4" aria-hidden="true" /> : <Award className="size-4" aria-hidden="true" />}
          Download Official Passing Certificate
        </Button>
        {!certificateAvailable && <p className="text-center text-xs text-muted-foreground">Certificate is issued once objectives are met.</p>}
      </div>
    </section>
  )
}
