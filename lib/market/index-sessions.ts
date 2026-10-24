/**
 * FXCM's published index CFD trading hours (GMT). Times are minutes after midnight,
 * with weekdays keyed by Date#getUTCDay() (0 = Sunday, 6 = Saturday).
 *
 * Source: FXCM CFD Trading Hours, https://docs.fxcorporate.com/user-guide/FXCMCFDTradingHours.pdf
 * FXCM keeps publishing the last quote outside these windows, so quotes are only usable
 * while the instrument is in session and the feed timestamp is fresh.
 */
type DayWindows = readonly (readonly [startMinute: number, endMinute: number])[]
type WeeklySession = Readonly<Record<number, DayWindows>>

const US_INDEX: WeeklySession = {
  0: [[22 * 60, 24 * 60]],
  1: [[0, 21 * 60], [22 * 60, 24 * 60]],
  2: [[0, 21 * 60], [22 * 60, 24 * 60]],
  3: [[0, 21 * 60], [22 * 60, 24 * 60]],
  4: [[0, 21 * 60], [22 * 60, 24 * 60]],
  5: [[0, 20 * 60 + 45]],
}

const AUS_200: WeeklySession = {
  0: [[22 * 60 + 50, 24 * 60]],
  1: [[0, 5 * 60 + 30], [6 * 60 + 10, 20 * 60], [22 * 60 + 50, 24 * 60]],
  2: [[0, 5 * 60 + 30], [6 * 60 + 10, 20 * 60], [22 * 60 + 50, 24 * 60]],
  3: [[0, 5 * 60 + 30], [6 * 60 + 10, 20 * 60], [22 * 60 + 50, 24 * 60]],
  4: [[0, 5 * 60 + 30], [6 * 60 + 10, 20 * 60], [22 * 60 + 50, 24 * 60]],
  5: [[0, 5 * 60 + 30], [6 * 60 + 10, 20 * 60]],
}

const CHN_50: WeeklySession = {
  1: [[60, 8 * 60 + 30], [9 * 60, 20 * 60 + 45]],
  2: [[60, 8 * 60 + 30], [9 * 60, 20 * 60 + 45]],
  3: [[60, 8 * 60 + 30], [9 * 60, 20 * 60 + 45]],
  4: [[60, 8 * 60 + 30], [9 * 60, 20 * 60 + 45]],
  5: [[60, 8 * 60 + 30], [9 * 60, 20 * 60 + 45]],
}

const EUROPE_6_TO_20: WeeklySession = {
  1: [[6 * 60, 20 * 60]],
  2: [[6 * 60, 20 * 60]],
  3: [[6 * 60, 20 * 60]],
  4: [[6 * 60, 20 * 60]],
  5: [[6 * 60, 20 * 60]],
}

const GER_40: WeeklySession = {
  1: [[30, 20 * 60]],
  2: [[30, 20 * 60]],
  3: [[30, 20 * 60]],
  4: [[30, 20 * 60]],
  5: [[30, 20 * 60]],
}

const UK_100: WeeklySession = {
  1: [[0, 20 * 60]],
  2: [[0, 20 * 60]],
  3: [[0, 20 * 60]],
  4: [[0, 20 * 60]],
  5: [[0, 20 * 60]],
}

const HKG_33: WeeklySession = {
  1: [[75, 4 * 60], [5 * 60, 8 * 60 + 30], [9 * 60 + 15, 19 * 60]],
  2: [[75, 4 * 60], [5 * 60, 8 * 60 + 30], [9 * 60 + 15, 19 * 60]],
  3: [[75, 4 * 60], [5 * 60, 8 * 60 + 30], [9 * 60 + 15, 19 * 60]],
  4: [[75, 4 * 60], [5 * 60, 8 * 60 + 30], [9 * 60 + 15, 19 * 60]],
  5: [[75, 4 * 60], [5 * 60, 8 * 60 + 30], [9 * 60 + 15, 19 * 60]],
}

const INDEX_SESSIONS = {
  US500: US_INDEX,
  US100: US_INDEX,
  US30: US_INDEX,
  US2000: US_INDEX,
  GER40: GER_40,
  UK100: UK_100,
  FRA40: EUROPE_6_TO_20,
  EU50: EUROPE_6_TO_20,
  JPN225: US_INDEX,
  HK50: HKG_33,
  AUS200: AUS_200,
  CN50: CHN_50,
} as const satisfies Record<string, WeeklySession>

export type IndexSessionSymbol = keyof typeof INDEX_SESSIONS

const INDEX_SYMBOL_SET = new Set<string>(Object.keys(INDEX_SESSIONS))

export function isIndexSymbol(symbol: string): symbol is IndexSessionSymbol {
  return INDEX_SYMBOL_SET.has(symbol)
}

/** Returns true for non-index symbols so callers can use it as a single market gate. */
export function isIndexMarketOpen(symbol: string, at: Date = new Date()): boolean {
  if (!isIndexSymbol(symbol)) return true

  const windows = INDEX_SESSIONS[symbol][at.getUTCDay()]
  if (!windows) return false

  const minute = at.getUTCHours() * 60 + at.getUTCMinutes()
  return windows.some(([start, end]) => minute >= start && minute < end)
}
