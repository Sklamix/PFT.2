import { cn } from '@/lib/utils'

export function DrawdownGauge({
  value,
  limit,
  label,
}: {
  value: number
  limit: number
  label: string
}) {
  const used = limit > 0 ? Math.min(1, Math.max(0, value / limit)) : 0
  const tone = used >= 1 ? 'bg-destructive' : used >= 0.8 ? 'bg-warning' : 'bg-primary'
  return (
    <div className="min-w-[140px]">
      <div className="flex items-baseline justify-between gap-2 font-mono text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn('tabular-nums', used >= 0.8 ? 'text-warning' : 'text-foreground')}>
          {value.toFixed(2)}% / {limit.toFixed(1)}%
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary">
        <div className={cn('h-full rounded-full transition-all', tone)} style={{ width: `${used * 100}%` }} />
      </div>
    </div>
  )
}
