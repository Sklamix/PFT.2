import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { RiskBadge } from '@/lib/admin/types'

export function RiskStatusBadge({ badge }: { badge: RiskBadge }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'rounded-md font-mono text-[10px] tracking-wide',
        badge === 'RULE BREACHED' && 'border-destructive/40 bg-destructive/15 text-destructive',
        badge === 'NEAR LIMIT' && 'border-warning/40 bg-warning/15 text-warning',
        badge === 'ACTIVE - PASSING' && 'border-primary/40 bg-primary/15 text-primary',
      )}
    >
      {badge}
    </Badge>
  )
}
