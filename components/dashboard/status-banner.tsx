import { KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { TradingAccount } from '@/lib/dashboard-data'
import { cn } from '@/lib/utils'
import { StatusDot } from './status-dot'

const STATUS_CHIP = {
  passing: 'border-primary/30 bg-primary/10 text-primary',
  funded: 'border-highlight/30 bg-highlight/10 text-highlight',
  breached: 'border-danger/30 bg-danger/10 text-danger',
} as const

export function StatusBanner({ account, onShowCredentials }: { account: TradingAccount; onShowCredentials: () => void }) {
  const fields = [
    { label: 'Account', value: account.id },
    { label: 'Server', value: account.server },
    { label: 'Phase', value: account.phase },
    { label: 'Leverage', value: account.leverage },
    { label: 'Platform', value: `${account.platform} · ${account.program}` },
  ]

  return (
    <section
      aria-label="Account status"
      className="relative overflow-hidden rounded-xl border border-border bg-card p-4 lg:p-5"
    >
      <div className="pointer-events-none absolute -right-20 -top-24 size-64 rounded-full bg-highlight/10 blur-3xl" aria-hidden="true" />
      <div className="relative flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-col gap-3">
          <span className={cn('inline-flex w-fit items-center gap-2 rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wider', STATUS_CHIP[account.status])}>
            <StatusDot status={account.status} />
            {account.statusLabel}
          </span>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
            {fields.map((field) => (
              <div key={field.label}>
                <dt className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{field.label}</dt>
                <dd className="mt-0.5 font-mono text-sm font-medium text-foreground">{field.value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <Button variant="outline" onClick={onShowCredentials} className="w-full border-highlight/40 text-highlight hover:text-highlight sm:w-fit">
          <KeyRound className="size-4" aria-hidden="true" />
          Show Trading Credentials
        </Button>
      </div>
    </section>
  )
}
