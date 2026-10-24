/**
 * Cash-market sessions for the index CFDs. FXCM keeps publishing the last quote outside
 * these windows, so we must not use those prices for orders or candles.
 *
 * Times are local exchange times; Intl handles daylight-saving transitions.
 */
export type IndexSession = {
  readonly timeZone: string
  readonly windows: readonly (readonly [startMinute: number, endMinute: number])[]
}

const INDEX_SESSIONS = {
  US500: { timeZone: 'America/New_York', windows: [[9 * 60 + 30, 16 * 60]] },
  US100: { timeZone: 'America/New_York', windows: [[9 * 60 + 30, 16 * 60]] },
  US30: { timeZone: 'America/New_York', windows: [[9 * 60 + 30, 16 * 60]] },
  US2000: { timeZone: 'America/New_York', windows: [[9 * 60 + 30, 16 * 60]] },
  GER40: { timeZone: 'Europe/Berlin', windows: [[9 * 60, 17 * 60 + 30]] },
  UK100: { timeZone: 'Europe/London', windows: [[8 * 60, 16 * 60 + 30]] },
  FRA40: { timeZone: 'Europe/Paris', windows: [[9 * 60, 17 * 60 + 30]] },
  EU50: { timeZone: 'Europe/Berlin', windows: [[9 * 60, 17 * 60 + 30]] },
  JPN225: { timeZone: 'Asia/Tokyo', windows: [[9 * 60, 11 * 60 + 30], [12 * 60 + 30, 15 * 60]] },
  HK50: { timeZone: 'Asia/Hong_Kong', windows: [[9 * 60 + 30, 12 * 60], [13 * 60, 16 * 60]] },
  AUS200: { timeZone: 'Australia/Sydney', windows: [[10 * 60, 16 * 60]] },
  CN50: { timeZone: 'Asia/Shanghai', windows: [[9 * 60 + 30, 11 * 60 + 30], [13 * 60, 15 * 60]] },
} as const satisfies Record<string, IndexSession>

export type IndexSessionSymbol = keyof typeof INDEX_SESSIONS

const INDEX_SYMBOL_SET = new Set<string>(Object.keys(INDEX_SESSIONS))
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string) {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

export function isIndexSymbol(symbol: string): symbol is IndexSessionSymbol {
  return INDEX_SYMBOL_SET.has(symbol)
}

/** Returns true for non-index symbols so callers can use it as a single market gate. */
export function isIndexMarketOpen(symbol: string, at: Date = new Date()): boolean {
  if (!isIndexSymbol(symbol)) return true

  const parts = formatterFor(INDEX_SESSIONS[symbol].timeZone).formatToParts(at)
  const weekday = WEEKDAY[parts.find((part) => part.type === 'weekday')?.value ?? '']
  if (weekday === undefined || weekday === 0 || weekday === 6) return false

  const hour = Number(parts.find((part) => part.type === 'hour')?.value)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false

  const localMinute = (hour % 24) * 60 + minute
  return INDEX_SESSIONS[symbol].windows.some(([start, end]) => localMinute >= start && localMinute < end)
}
