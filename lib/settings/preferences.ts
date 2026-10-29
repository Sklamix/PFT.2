import { prisma } from '@/lib/prisma'
import { isSupportedTimeZone } from './timezones'
import {
  DATE_FORMATS,
  DEFAULT_PREFERENCES,
  INTERFACE_LANGUAGES,
  NUMBER_FORMATS,
  DISPLAY_CURRENCIES,
  type Preferences,
} from './format'

export type PreferenceInput = {
  timeZone?: unknown
  dateFormat?: unknown
  numberFormat?: unknown
  interfaceLanguage?: unknown
  displayCurrency?: unknown
}

export const PREFERENCE_SELECT = {
  interfaceLanguage: true,
  dateFormat: true,
  numberFormat: true,
  displayCurrency: true,
  timeZone: true,
} as const

export function normalizePreferences(row: Partial<Preferences> | null | undefined): Preferences {
  if (!row) return { ...DEFAULT_PREFERENCES }
  return {
    interfaceLanguage: row.interfaceLanguage ?? DEFAULT_PREFERENCES.interfaceLanguage,
    dateFormat: row.dateFormat ?? DEFAULT_PREFERENCES.dateFormat,
    numberFormat: row.numberFormat ?? DEFAULT_PREFERENCES.numberFormat,
    displayCurrency: row.displayCurrency ?? DEFAULT_PREFERENCES.displayCurrency,
    timeZone: row.timeZone ?? DEFAULT_PREFERENCES.timeZone,
  }
}

export async function getUserPreferences(userId: string): Promise<Preferences> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: PREFERENCE_SELECT })
  return normalizePreferences(row)
}

/** Validates every submitted preference. Unknown or malformed values are rejected, never coerced. */
export function validatePreferences(input: PreferenceInput):
  | { ok: true; data: Partial<Preferences> }
  | { ok: false; error: string } {
  const data: Partial<Preferences> = {}

  if (input.timeZone !== undefined) {
    const value = typeof input.timeZone === 'string' ? input.timeZone.trim() : ''
    if (!value || !isSupportedTimeZone(value)) return { ok: false, error: 'Unsupported timezone.' }
    data.timeZone = value
  }
  if (input.dateFormat !== undefined) {
    const value = typeof input.dateFormat === 'string' ? input.dateFormat : ''
    if (!(DATE_FORMATS as readonly string[]).includes(value)) return { ok: false, error: 'Unsupported date format.' }
    data.dateFormat = value
  }
  if (input.numberFormat !== undefined) {
    const value = typeof input.numberFormat === 'string' ? input.numberFormat : ''
    if (!(NUMBER_FORMATS as readonly string[]).includes(value)) return { ok: false, error: 'Unsupported number format.' }
    data.numberFormat = value
  }
  if (input.interfaceLanguage !== undefined) {
    const value = typeof input.interfaceLanguage === 'string' ? input.interfaceLanguage : ''
    if (!INTERFACE_LANGUAGES.some((language) => language.value === value)) {
      return { ok: false, error: 'This interface language is not available.' }
    }
    data.interfaceLanguage = value
  }
  if (input.displayCurrency !== undefined) {
    const value = typeof input.displayCurrency === 'string' ? input.displayCurrency : ''
    if (!DISPLAY_CURRENCIES.some((currency) => currency.value === value)) {
      return { ok: false, error: 'Unsupported display currency. Balances are settled in USD.' }
    }
    data.displayCurrency = value
  }

  if (Object.keys(data).length === 0) return { ok: false, error: 'No supported preferences were submitted.' }
  return { ok: true, data }
}

export async function saveUserPreferences(userId: string, data: Partial<Preferences>) {
  // Only the whitelisted columns above ever reach this update; no mass assignment.
  await prisma.user.update({ where: { id: userId }, data })
  return getUserPreferences(userId)
}
