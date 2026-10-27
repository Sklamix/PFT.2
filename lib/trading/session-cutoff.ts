import { isIndexCloseOnly, isIndexMarketOpen, isIndexSymbol } from '@/lib/market/index-sessions'

const CLOSE_ONLY_MINUTES = 15

function londonOffsetMinutes(date: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    timeZoneName: 'longOffset',
  }).formatToParts(date)
  const value = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT'
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(value)
  if (!match) return 0
  const sign = match[1] === '-' ? -1 : 1
  return sign * (Number(match[2]) * 60 + Number(match[3]))
}

/** FX/metals default close: 22:00 London, expressed in UTC. */
function defaultCutoffUtc(now: Date) {
  const day = now.getUTCDay()
  if (day === 0 || day === 6) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0))
  }
  if (day === 5) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 21, 0, 0, 0))
  }
  const hour = londonOffsetMinutes(now) === 60 ? 21 : 22
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0, 0))
}

function isWeekend(now: Date) {
  const day = now.getUTCDay()
  return day === 0 || day === 6
}

export function isDefaultCloseOnly(now = new Date()) {
  if (isWeekend(now)) return true
  const cutoff = defaultCutoffUtc(now)
  const remaining = cutoff.getTime() - now.getTime()
  if (remaining >= 0) return remaining <= CLOSE_ONLY_MINUTES * 60_000
  // After the daily cutoff the market is closed for new positions until the next UTC day.
  return true
}

export function isDefaultPastCutoff(now = new Date()) {
  if (isWeekend(now)) return true
  return now.getTime() >= defaultCutoffUtc(now).getTime()
}

export function isCloseOnlyForSymbol(symbol: string, now = new Date()) {
  if (isIndexSymbol(symbol)) {
    return !isIndexMarketOpen(symbol, now) || isIndexCloseOnly(symbol, now)
  }
  return isDefaultCloseOnly(now)
}

export function shouldAutoCloseSymbol(symbol: string, now = new Date()) {
  if (isIndexSymbol(symbol)) {
    return !isIndexMarketOpen(symbol, now)
  }
  return isDefaultPastCutoff(now)
}
