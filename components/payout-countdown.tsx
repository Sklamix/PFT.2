'use client'

import { useEffect, useState } from 'react'

const CYCLE_MS = 14 * 24 * 60 * 60 * 1000
const CYCLE_ANCHOR = Date.UTC(2026, 0, 2)

function getRemaining(now: number) {
  const elapsed = (now - CYCLE_ANCHOR) % CYCLE_MS
  return CYCLE_MS - elapsed
}

const pad = (value: number) => value.toString().padStart(2, '0')

export function PayoutCountdown() {
  const [remaining, setRemaining] = useState<number | null>(null)

  useEffect(() => {
    const tick = () => setRemaining(getRemaining(Date.now()))
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [])

  const segments =
    remaining === null
      ? ['--', '--', '--', '--']
      : [
          pad(Math.floor(remaining / 86_400_000)),
          pad(Math.floor((remaining / 3_600_000) % 24)),
          pad(Math.floor((remaining / 60_000) % 60)),
          pad(Math.floor((remaining / 1000) % 60)),
        ]

  return (
    <div className="grid grid-cols-4 gap-2" role="timer" aria-label="Time until next payout window">
      {['Days', 'Hrs', 'Min', 'Sec'].map((label, index) => (
        <div key={label} className="rounded-md border border-border bg-background px-2 py-2 text-center">
          <span className="block font-mono text-xl font-semibold tabular-nums text-foreground">{segments[index]}</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
        </div>
      ))}
    </div>
  )
}
