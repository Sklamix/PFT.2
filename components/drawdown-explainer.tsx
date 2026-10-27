'use client'

import { useState } from 'react'
import { SegmentedControl } from '@/components/segmented-control'

type Mode = 'balance' | 'equity'

const EQUITY = [100, 101.8, 103.6, 102.4, 105.2, 104.1, 107.3, 106, 108.6, 105.4, 104.2, 106.8]
const WIDTH = 480
const HEIGHT = 220
const PADDING = { top: 16, right: 16, bottom: 24, left: 40 }
const MIN = 86
const MAX = 112

const toX = (index: number) =>
  PADDING.left + (index / (EQUITY.length - 1)) * (WIDTH - PADDING.left - PADDING.right)
const toY = (value: number) =>
  PADDING.top + ((MAX - value) / (MAX - MIN)) * (HEIGHT - PADDING.top - PADDING.bottom)

function buildFloor(mode: Mode) {
  let highWater = EQUITY[0]
  return EQUITY.map((value) => {
    highWater = Math.max(highWater, value)
    return mode === 'balance' ? 90 : highWater - 10
  })
}

const linePath = (values: number[]) =>
  values.map((value, index) => `${index === 0 ? 'M' : 'L'}${toX(index).toFixed(1)},${toY(value).toFixed(1)}`).join(' ')

const MODE_COPY: Record<Mode, { title: string; body: string }> = {
  balance: {
    title: 'Balance-based (static)',
    body: 'Your breach level is fixed at 10% below the initial balance — $90,000 on a $100k account — and never moves, no matter how much profit you build.',
  },
  equity: {
    title: 'Equity-based (trailing)',
    body: 'Your breach level stays a fixed 10% below the highest equity reached. The floor only moves up and never moves down.',
  },
}

export function DrawdownExplainer() {
  const [mode, setMode] = useState<Mode>('balance')
  const floor = buildFloor(mode)
  const lastIndex = EQUITY.length - 1
  const buffer = EQUITY[lastIndex] - floor[lastIndex]

  return (
    <div className="cosmic-card flex flex-col gap-5 rounded-[1.75rem] p-5 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="text-base font-semibold text-white">Drawdown visual explainer</h3>
        <SegmentedControl
          label="Drawdown calculation"
          options={[
            { value: 'balance', label: 'Balance-based' },
            { value: 'equity', label: 'Equity-based' },
          ]}
          value={mode}
          onChange={setMode}
          size="sm"
          className="sm:w-64"
        />
      </div>

      <figure className="overflow-hidden rounded-xl border border-white/10 bg-black/25 p-2">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="h-auto w-full"
          role="img"
          aria-label={`Chart comparing account equity with the ${MODE_COPY[mode].title} breach level`}
        >
          <defs>
            <linearGradient id="dd-risk" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--danger)" stopOpacity="0.25" />
              <stop offset="100%" stopColor="var(--danger)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[90, 100, 110].map((tick) => (
            <g key={tick}>
              <line
                x1={PADDING.left}
                x2={WIDTH - PADDING.right}
                y1={toY(tick)}
                y2={toY(tick)}
                stroke="var(--border)"
                strokeDasharray="3 4"
              />
              <text x={PADDING.left - 8} y={toY(tick) + 4} textAnchor="end" fontSize="10" fill="var(--muted-foreground)" className="font-mono">
                {`${tick}k`}
              </text>
            </g>
          ))}
          <path
            d={`${linePath(floor)} L${toX(lastIndex)},${HEIGHT - PADDING.bottom} L${toX(0)},${HEIGHT - PADDING.bottom} Z`}
            fill="url(#dd-risk)"
            className="transition-all duration-500"
          />
          <path d={linePath(floor)} fill="none" stroke="var(--danger)" strokeWidth="2" strokeDasharray="6 4" className="transition-all duration-500" />
          <path d={linePath(EQUITY)} fill="none" stroke="var(--primary)" strokeWidth="2.5" strokeLinejoin="round" />
          <circle cx={toX(lastIndex)} cy={toY(EQUITY[lastIndex])} r="4" fill="var(--primary)" />
        </svg>
        <figcaption className="flex flex-wrap items-center gap-x-5 gap-y-1 px-2 pt-2 pb-1 text-xs text-slate-500">
          <span className="flex items-center gap-2">
            <span className="h-0.5 w-4 rounded bg-primary" /> Equity
          </span>
          <span className="flex items-center gap-2">
            <span className="h-0.5 w-4 rounded bg-danger" /> Breach level
          </span>
          <span className="ml-auto font-mono text-slate-300">
            Buffer: <span className="text-primary">${(buffer * 1000).toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
          </span>
        </figcaption>
      </figure>

      <div aria-live="polite">
        <p className="text-sm font-medium text-white">{MODE_COPY[mode].title}</p>
        <p className="mt-1 text-sm leading-relaxed text-slate-400">{MODE_COPY[mode].body}</p>
      </div>
    </div>
  )
}
