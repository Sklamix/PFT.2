import { Prisma } from '@prisma/client'
import type { Quote, Quotes } from '@/lib/trading/types'
import { toDecimal } from './money'

/**
 * Quote-currency to USD conversion.
 *
 * USD-quoted instruments convert 1:1. Everything else is derived from the same
 * provider quotes used by the trading engine; no synthetic rates are created.
 */

export const FX_MAX_AGE_MS = 5_000

export type FxRateInfo = {
  rate: Prisma.Decimal
  /** Provider timestamp in epoch milliseconds. */
  timestamp: number
  source: string
  stale: boolean
}

export type FxSnapshot = {
  symbol: string
  bid: number
  ask: number
  providerTime: number
  source: string
}

const INVERSE = new Set(['JPY', 'CHF', 'CAD'])
const DIRECT = new Set(['GBP', 'AUD', 'NZD', 'EUR'])

function mid(bid: number, ask: number): number | null {
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null
  return (bid + ask) / 2
}

export class FxTable {
  private readonly rates = new Map<string, FxRateInfo>()
  private readonly now: number

  constructor(now = Date.now()) {
    this.now = now
  }

  static fromSnapshots(snapshots: readonly FxSnapshot[], now = Date.now()): FxTable {
    const table = new FxTable(now)
    for (const snapshot of snapshots) {
      const price = mid(snapshot.bid, snapshot.ask)
      if (price == null) continue
      table.setQuote(snapshot.symbol, price, snapshot.providerTime, snapshot.source)
    }
    return table
  }

  static fromQuotes(quotes: Quotes, now = Date.now()): FxTable {
    const table = new FxTable(now)
    for (const [symbol, quote] of Object.entries(quotes)) {
      if (!quote) continue
      const price = mid(quote.bid, quote.ask)
      if (price == null) continue
      table.setQuote(symbol, price, now, 'LIVE_QUOTES')
    }
    return table
  }

  private setQuote(symbol: string, price: number, timestamp: number, source: string) {
    this.rates.set(symbol.toUpperCase(), {
      rate: toDecimal(price),
      timestamp,
      source,
      stale: this.now - timestamp > FX_MAX_AGE_MS,
    })
  }

  rateFor(currency: string, options: { allowStale?: boolean } = {}): FxRateInfo | null {
    if (currency === 'USD') {
      return { rate: toDecimal(1), timestamp: this.now, source: 'USD', stale: false }
    }

    let info: FxRateInfo | null = null
    if (INVERSE.has(currency)) {
      const pair = this.rates.get(`USD${currency}`)
      if (pair && pair.rate.greaterThan(0)) {
        info = { ...pair, rate: toDecimal(1).dividedBy(pair.rate) }
      }
    } else if (DIRECT.has(currency)) {
      info = this.rates.get(`${currency}USD`) ?? null
    }

    if (!info) return null
    if (info.stale && !options.allowStale) return null
    return info
  }

  convert(amount: Prisma.Decimal, currency: string, options: { allowStale?: boolean } = {}) {
    const info = this.rateFor(currency, options)
    if (!info) return null
    return { amountUsd: amount.times(info.rate), ...info }
  }
}

export function quoteFromFxTable(table: FxTable, currency: string): Quote | null {
  const info = table.rateFor(currency)
  if (!info) return null
  const rate = Number(info.rate)
  return { bid: rate, ask: rate }
}
