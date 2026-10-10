import type { AccountStatus, Severity } from '@/lib/dashboard-data'
import { cn } from '@/lib/utils'

const STATUS_CLASS: Record<AccountStatus, string> = {
  passing: 'bg-primary shadow-[0_0_8px_var(--primary)]',
  funded: 'bg-highlight shadow-[0_0_8px_var(--highlight)]',
  breached: 'bg-danger shadow-[0_0_8px_var(--danger)]',
}

export function StatusDot({ status }: { status: AccountStatus }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', STATUS_CLASS[status])} aria-hidden="true" />
}

export const SEVERITY_TEXT: Record<Severity, string> = {
  safe: 'text-primary',
  caution: 'text-warning',
  danger: 'text-danger',
}

export const SEVERITY_BG: Record<Severity, string> = {
  safe: 'bg-primary',
  caution: 'bg-warning',
  danger: 'bg-danger',
}

export const SEVERITY_CHIP: Record<Severity, string> = {
  safe: 'border-primary/30 bg-primary/10 text-primary',
  caution: 'border-warning/30 bg-warning/10 text-warning',
  danger: 'border-danger/30 bg-danger/10 text-danger',
}
