import { FOREX_MAJORS, getSymbol, isTerminalSymbol } from '@/lib/constants/symbols'
import type { CloseInput, OrderInput, Quote, Quotes } from './types'

export const TRADABLE_SYMBOLS: readonly string[] = FOREX_MAJORS
export const MIN_LOTS = 0.01
export const MAX_LOTS = 50
const MAX_SPREAD_PIPS = 50
/** Client quotes further than this from the symbol reference are rejected as implausible. */
const MAX_REFERENCE_DEVIATION = 0.25

export class ValidationError extends Error {}

type Body = Record<string, unknown>

function asBody(value: unknown): Body {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Request body must be a JSON object')
  return value as Body
}

function requiredString(body: Body, key: string) {
  const value = body[key]
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${key} is required`)
  return value.trim()
}

function optionalPrice(body: Body, key: string) {
  const value = body[key]
  if (value == null || value === '') return null
  const num = typeof value === 'string' ? Number(value) : value
  if (typeof num !== 'number' || !Number.isFinite(num) || num <= 0) throw new ValidationError(`${key} must be a positive number`)
  return num
}

export function parseQuote(symbol: string, value: unknown): Quote {
  if (!value || typeof value !== 'object') throw new ValidationError(`Quote for ${symbol} is required`)
  const { bid, ask } = value as Record<string, unknown>
  if (typeof bid !== 'number' || typeof ask !== 'number' || !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
    throw new ValidationError(`Quote for ${symbol} must include positive bid and ask`)
  }
  if (ask < bid) throw new ValidationError(`Quote for ${symbol} has ask below bid`)
  const meta = getSymbol(symbol)
  if ((ask - bid) / meta.pipSize > MAX_SPREAD_PIPS) throw new ValidationError(`Quote for ${symbol} has an implausible spread`)
  const mid = (bid + ask) / 2
  if (Math.abs(mid - meta.mockBasePrice) / meta.mockBasePrice > MAX_REFERENCE_DEVIATION) {
    throw new ValidationError(`Quote for ${symbol} is outside the accepted price band`)
  }
  return { bid, ask }
}

export function parseQuotes(value: unknown): Quotes {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('quotes must be an object keyed by symbol')
  const quotes: Quotes = {}
  for (const [symbol, quote] of Object.entries(value as Record<string, unknown>)) {
    if (!isTerminalSymbol(symbol)) throw new ValidationError(`Unknown symbol ${symbol}`)
    quotes[symbol] = parseQuote(symbol, quote)
  }
  return quotes
}

export function parseOrderInput(raw: unknown): OrderInput {
  const body = asBody(raw)
  const accountId = requiredString(body, 'accountId')
  const symbol = requiredString(body, 'symbol').toUpperCase()
  if (!TRADABLE_SYMBOLS.includes(symbol)) throw new ValidationError(`symbol must be one of ${TRADABLE_SYMBOLS.join(', ')}`)

  const side = body.side
  if (side !== 'BUY' && side !== 'SELL') throw new ValidationError('side must be BUY or SELL')

  const orderType = body.orderType ?? 'MARKET'
  if (orderType !== 'MARKET') throw new ValidationError('orderType must be MARKET')

  const lotsRaw = typeof body.lots === 'string' ? Number(body.lots) : body.lots
  if (typeof lotsRaw !== 'number' || !Number.isFinite(lotsRaw)) throw new ValidationError('lots must be a number')
  const lots = Math.round(lotsRaw * 100) / 100
  if (Math.abs(lots - lotsRaw) > 1e-9) throw new ValidationError('lots must be in steps of 0.01')
  if (lots < MIN_LOTS || lots > MAX_LOTS) throw new ValidationError(`lots must be between ${MIN_LOTS} and ${MAX_LOTS}`)

  return {
    accountId,
    symbol,
    side,
    lots,
    orderType,
    stopLoss: optionalPrice(body, 'stopLoss'),
    takeProfit: optionalPrice(body, 'takeProfit'),
    quote: parseQuote(symbol, body.quote),
  }
}

export function parseCloseInput(raw: unknown): CloseInput {
  const body = asBody(raw)
  const accountId = typeof body.accountId === 'string' && body.accountId.trim() ? body.accountId.trim() : null
  return { positionId: requiredString(body, 'positionId'), accountId, quote: body.quote ?? null }
}
