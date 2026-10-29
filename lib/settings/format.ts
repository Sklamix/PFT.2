/** Server-safe date/number formatting driven by the trader's saved preferences. */

export const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'] as const
export type DateFormat = (typeof DATE_FORMATS)[number]

export const NUMBER_FORMATS = ['1,234.56', '1 234,56'] as const
export type NumberFormat = (typeof NUMBER_FORMATS)[number]

/** Only English ships today — no i18n bundle exists in the product yet. */
export const INTERFACE_LANGUAGES = [{ value: 'en', label: 'English' }] as const

/** Amounts are always settled in USD; this is a display label only. */
export const DISPLAY_CURRENCIES = [{ value: 'USD', label: 'USD — US dollar' }] as const

export type Preferences = {
  interfaceLanguage: string
  dateFormat: string
  numberFormat: string
  displayCurrency: string
  timeZone: string
}

export const DEFAULT_PREFERENCES: Preferences = {
  interfaceLanguage: 'en',
  dateFormat: 'DD/MM/YYYY',
  numberFormat: '1,234.56',
  displayCurrency: 'USD',
  timeZone: 'UTC',
}

export function formatDate(value: Date | string, prefs: Pick<Preferences, 'dateFormat' | 'timeZone'>) {
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return '—'
  const dd = String(date.getUTCDate()).padStart(2, '0')
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const yyyy = String(date.getUTCFullYear())
  void prefs.timeZone // timezone is applied by formatDateTime; keep the API symmetric
  switch (prefs.dateFormat) {
    case 'MM/DD/YYYY':
      return `${mm}/${dd}/${yyyy}`
    case 'YYYY-MM-DD':
      return `${yyyy}-${mm}-${dd}`
    case 'DD/MM/YYYY':
    default:
      return `${dd}/${mm}/${yyyy}`
  }
}

export function formatDateTime(value: Date | string, prefs: Pick<Preferences, 'dateFormat' | 'timeZone'>) {
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return '—'
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: prefs.timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date)
  } catch {
    return '—'
  }
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  const yyyy = get('year')
  const mm = get('month')
  const dd = get('day')
  const time = `${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}`
  switch (prefs.dateFormat) {
    case 'MM/DD/YYYY':
      return `${mm}/${dd}/${yyyy} ${time}`
    case 'YYYY-MM-DD':
      return `${yyyy}-${mm}-${dd} ${time}`
    case 'DD/MM/YYYY':
    default:
      return `${dd}/${mm}/${yyyy} ${time}`
  }
}

/** Formats a USD amount using the selected thousands/decimal separators. */
export function formatAmount(value: number, prefs: Pick<Preferences, 'numberFormat'>) {
  if (!Number.isFinite(value)) return '—'
  const fixed = Math.abs(value).toFixed(2)
  const [integer, fraction] = fixed.split('.')
  const grouped =
    prefs.numberFormat === '1 234,56'
      ? `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}`
      : integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const separator = prefs.numberFormat === '1 234,56' ? ',' : '.'
  return `${value < 0 ? '-' : ''}${grouped}${separator}${fraction}`
}
