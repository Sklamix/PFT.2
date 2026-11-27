/** Shared level palette. The chart paints these colours; UI text must match. */
export const LEVEL_HEX = {
  sl: '#fb923c',
  tp: '#22c55e',
  limitBuy: '#3b82f6',
  limitSell: '#f43f5e',
  stop: '#f59e0b',
} as const

/** Tailwind classes paired with the hex values above. */
export const LEVEL_CLASS = {
  sl: { text: 'text-orange-300', border: 'border-orange-500/40', bg: 'bg-orange-500/10' },
  tp: { text: 'text-emerald-300', border: 'border-emerald-500/40', bg: 'bg-emerald-500/10' },
} as const
