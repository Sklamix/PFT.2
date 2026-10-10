import { cn } from '@/lib/utils'

export function PulseMeter({
  value,
  max = 100,
  size = 52,
  tone = 'cyan',
}: {
  value: number
  max?: number
  size?: number
  tone?: 'cyan' | 'emerald' | 'amber'
}) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
  const radius = 18
  const circumference = 2 * Math.PI * radius
  const stroke = tone === 'emerald' ? '#10b981' : tone === 'amber' ? '#f59e0b' : '#06b6d4'

  return (
    <svg width={size} height={size} viewBox="0 0 48 48" className="shrink-0 -rotate-90">
      <circle cx="24" cy="24" r={radius} fill="none" stroke="#1e293b" strokeWidth="4" />
      <circle
        cx="24"
        cy="24"
        r={radius}
        fill="none"
        stroke={stroke}
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - ratio)}
        className={cn(tone === 'cyan' && 'drop-shadow-[0_0_6px_#06b6d4]', tone === 'emerald' && 'drop-shadow-[0_0_6px_#10b981]')}
      />
    </svg>
  )
}
