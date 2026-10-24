import {
  AsYouType,
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js'

export type CountryOption = {
  code: CountryCode
  name: string
  dialCode: string
  flag: string
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })

function flagFor(code: string) {
  return String.fromCodePoint(...code.split('').map((letter) => 127397 + letter.charCodeAt(0)))
}

export const COUNTRY_OPTIONS: CountryOption[] = getCountries()
  .map((code) => ({
    code,
    name: regionNames.of(code) ?? code,
    dialCode: `+${getCountryCallingCode(code)}`,
    flag: flagFor(code),
  }))
  .sort((a, b) => a.name.localeCompare(b.name))

const byCode = new Map(COUNTRY_OPTIONS.map((country) => [country.code, country]))
const byName = new Map(COUNTRY_OPTIONS.map((country) => [country.name.toLowerCase(), country]))

export function countryByValue(value: string | null | undefined): CountryOption | null {
  const input = value?.trim()
  if (!input) return null
  const upper = input.toUpperCase()
  if (upper.length === 2) return byCode.get(upper as CountryCode) ?? null
  return byName.get(input.toLowerCase()) ?? null
}

export function countryByCode(code: string | null | undefined): CountryOption | null {
  if (!code) return null
  return byCode.get(code.toUpperCase() as CountryCode) ?? null
}

export function nationalDigits(value: string) {
  return value.replace(/\D/g, '').slice(0, 15)
}

export function parseStoredPhone(value: string | null | undefined): { country: CountryCode | null; digits: string } {
  if (!value) return { country: null, digits: '' }
  const parsed = parsePhoneNumberFromString(value)
  return {
    country: parsed?.country ?? null,
    digits: parsed?.nationalNumber ?? nationalDigits(value),
  }
}

export function formatNationalNumber(country: CountryCode | null, digits: string) {
  if (!country || !digits) return digits
  return new AsYouType(country).input(digits)
}

export function toE164(country: CountryCode | null, digits: string) {
  const clean = nationalDigits(digits)
  if (!country || !clean) return ''
  const parsed = parsePhoneNumberFromString(clean, country)
  return parsed?.number ?? `+${getCountryCallingCode(country)}${clean}`
}

export function phonePreview(country: CountryCode | null, digits: string) {
  const e164 = toE164(country, digits)
  if (!e164) return ''
  const parsed = parsePhoneNumberFromString(e164)
  return parsed?.isValid() ? parsed.formatInternational() : e164
}

export function isPhoneValid(country: CountryCode | null, digits: string) {
  const e164 = toE164(country, digits)
  if (!e164) return false
  return parsePhoneNumberFromString(e164)?.isValid() ?? false
}
