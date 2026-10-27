'use client'

import { FormEvent, useEffect, useState } from 'react'
import { ArrowLeft, LoaderCircle, Save } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { CountryCombobox } from '@/components/profile/country-combobox'
import { KYCSection } from '@/components/profile/kyc-section'
import { PhoneInput } from '@/components/profile/phone-input'
import { countryByCode, countryByValue, isPhoneValid, parseStoredPhone, toE164 } from '@/lib/countries'

type Profile = {
  email: string
  name: string
  nickname: string | null
  dateOfBirth: string
  phone: string | null
  country: string | null
  avatarUrl: string | null
  declaredVpsCountry: string | null
}

const FIELD_CLASS =
  'mt-2 h-11 w-full rounded-lg border border-white/10 bg-[#090d12] px-3 text-sm text-white outline-none focus:border-lime-400/70 focus:ring-2 focus:ring-lime-400/10'

export function ProfileForm({ mode }: { mode: 'setup' | 'settings' }) {
  const router = useRouter()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [name, setName] = useState('')
  const [nickname, setNickname] = useState('')
  const [dateOfBirth, setDateOfBirth] = useState('')
  const [phoneCountry, setPhoneCountry] = useState('')
  const [phoneDigits, setPhoneDigits] = useState('')
  const [country, setCountry] = useState('')
  const [vpsCountry, setVpsCountry] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let active = true
    fetch('/api/profile', { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Unable to load profile.')
        if (!active) return
        const value = data.profile as Profile
        setProfile(value)
        const residence = countryByValue(value.country)
        const storedPhone = parseStoredPhone(value.phone)
        setName(value.name)
        setNickname(value.nickname ?? '')
        setDateOfBirth(value.dateOfBirth)
        setCountry(residence?.code ?? '')
        setVpsCountry(countryByValue(value.declaredVpsCountry)?.code ?? '')
        setPhoneCountry(storedPhone.country ?? residence?.code ?? '')
        setPhoneDigits(storedPhone.digits)
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Unable to load profile.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    setSaved(false)
    const phone = toE164(countryByCode(phoneCountry)?.code ?? null, phoneDigits)
    if (!countryByValue(country)) {
      setError('Select your country of residence.')
      setSaving(false)
      return
    }
    if (!isPhoneValid(countryByCode(phoneCountry)?.code ?? null, phoneDigits)) {
      setError('Enter a valid phone number for the selected country.')
      setSaving(false)
      return
    }
    try {
      const response = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          nickname,
          dateOfBirth,
          phone,
          country,
          ...(mode === 'settings' ? { declaredVpsCountry: vpsCountry } : {}),
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to save profile.')
      setProfile((current) => current ? { ...current, ...data.profile } : current)
      setSaved(true)
      if (mode === 'setup') {
        router.replace('/dashboard')
        router.refresh()
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save profile.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="min-h-dvh bg-[#080b0f] px-4 py-10 text-white sm:px-6">
      <div className="mx-auto w-full max-w-2xl">
        <Link href={mode === 'settings' ? '/dashboard' : '/auth/login'} className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-lime-300">
          <ArrowLeft className="size-4" /> {mode === 'settings' ? 'Back to dashboard' : 'Back to sign in'}
        </Link>
        <header className="mt-10">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-lime-300">Trader profile</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">
            {mode === 'setup' ? 'Set up your profile' : 'Profile settings'}
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Add the details needed to personalize your account. You can update them later.
          </p>
        </header>

        <section className="mt-8 rounded-2xl border border-white/10 bg-[#0e1319] p-5 sm:p-8">
          {loading ? (
            <p className="py-8 text-sm text-slate-400">Loading profile…</p>
          ) : (
            <form onSubmit={(event) => void save(event)} className="grid gap-5 sm:grid-cols-2">
              <label className="text-sm text-slate-300 sm:col-span-2">
                Email
                <input value={profile?.email ?? ''} readOnly className={`${FIELD_CLASS} cursor-not-allowed text-slate-500`} />
              </label>
              <label className="text-sm text-slate-300 sm:col-span-2">
                First and last name
                <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required minLength={2} maxLength={100} className={FIELD_CLASS} />
              </label>
              <label className="text-sm text-slate-300">
                Nickname
                <input value={nickname} onChange={(event) => setNickname(event.target.value)} autoComplete="nickname" required minLength={2} maxLength={30} className={FIELD_CLASS} />
              </label>
              <label className="text-sm text-slate-300">
                Date of birth
                <input type="date" value={dateOfBirth} onChange={(event) => setDateOfBirth(event.target.value)} required max={new Date().toISOString().slice(0, 10)} className={FIELD_CLASS} />
              </label>
              <div className="sm:col-span-2">
                <CountryCombobox
                  value={country}
                  onChange={(code) => {
                    setCountry(code)
                    setPhoneCountry(code)
                  }}
                />
              </div>
              {mode === 'settings' ? (
                <div className="sm:col-span-2">
                  <CountryCombobox
                    id="vps-country"
                    label="VPS country (optional)"
                    placeholder="Search country…"
                    value={vpsCountry}
                    onChange={setVpsCountry}
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    Declare the country of the VPS you trade from. Sign-ins from another country raise a security
                    alert.
                  </p>
                  {vpsCountry ? (
                    <button
                      type="button"
                      onClick={() => setVpsCountry('')}
                      className="mt-1 text-xs text-slate-400 underline underline-offset-2 hover:text-slate-200"
                    >
                      Clear VPS declaration
                    </button>
                  ) : null}
                </div>
              ) : null}
              <PhoneInput
                country={phoneCountry}
                onCountryChange={setPhoneCountry}
                value={phoneDigits}
                onChange={setPhoneDigits}
                error={error}
              />

              {error && <p role="alert" className="text-sm text-rose-400 sm:col-span-2">{error}</p>}
              {saved && mode === 'settings' && <p role="status" className="text-sm text-lime-300 sm:col-span-2">Profile saved.</p>}
              <div className="flex flex-col gap-3 pt-2 sm:col-span-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-slate-500">Your profile information is stored securely with your account.</p>
                <button type="submit" disabled={saving} className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-lime-300 px-5 text-sm font-bold text-[#11160b] transition hover:bg-lime-200 disabled:opacity-60">
                  {saving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                  {saving ? 'Saving…' : 'Save profile'}
                </button>
              </div>
            </form>
          )}
        </section>

        {mode === 'settings' && <KYCSection />}
      </div>
    </main>
  )
}
