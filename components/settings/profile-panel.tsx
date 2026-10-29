'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { Loader2, Save } from 'lucide-react'
import { CountryCombobox } from '@/components/profile/country-combobox'
import { KYCSection } from '@/components/profile/kyc-section'
import { PhoneInput } from '@/components/profile/phone-input'
import { countryByCode, countryByValue, isPhoneValid, parseStoredPhone, toE164 } from '@/lib/countries'
import { Field, INPUT_CLASS, Notice, Panel } from './ui'

type Profile = {
  email: string
  name: string
  nickname: string | null
  dateOfBirth: string
  phone: string | null
  country: string | null
  avatarUrl: string | null
  declaredVpsCountry: string | null
  emailVerified?: boolean
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '—'
  return (parts[0]![0]! + (parts[1]?.[0] ?? '')).toUpperCase()
}

export function ProfilePanel({ onProfileChange }: { onProfileChange?: () => void }) {
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
        const payload = (await response.json().catch(() => ({}))) as { profile?: Profile; error?: string }
        if (!response.ok || !payload.profile) throw new Error(payload.error ?? 'Unable to load profile.')
        if (!active) return
        setProfile(payload.profile)
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

  useEffect(() => {
    if (!profile) return
    const residence = countryByValue(profile.country)
    const storedPhone = parseStoredPhone(profile.phone)
    setName(profile.name)
    setNickname(profile.nickname ?? '')
    setDateOfBirth(profile.dateOfBirth)
    setCountry(residence?.code ?? '')
    setVpsCountry(countryByValue(profile.declaredVpsCountry)?.code ?? '')
    setPhoneCountry(storedPhone.country ?? residence?.code ?? '')
    setPhoneDigits(storedPhone.digits)
    setSaved(false)
    setError(null)
  }, [profile])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const phone = toE164(countryByCode(phoneCountry)?.code ?? null, phoneDigits)
      if (!countryByValue(country)) throw new Error('Select your country of residence.')
      if (!isPhoneValid(countryByCode(phoneCountry)?.code ?? null, phoneDigits)) {
        throw new Error('Enter a valid phone number for the selected country.')
      }
      const response = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, nickname, dateOfBirth, phone, country, declaredVpsCountry: vpsCountry }),
      })
      const data = (await response.json().catch(() => ({}))) as { error?: string; profile?: Partial<Profile> }
      if (!response.ok) throw new Error(data.error ?? 'Unable to save profile.')
      if (data.profile) setProfile((current) => (current ? { ...current, ...data.profile } : current))
      setSaved(true)
      onProfileChange?.()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save profile.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-card/80 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading profile…
      </div>
    )
  }
  if (!profile) return <Notice tone="error">{error ?? 'Unable to load profile.'}</Notice>

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Profile" description="How your trader identity appears across PFT. Your email is used for sign-in and is not editable here.">
        <div className="mb-5 flex items-center gap-4">
          <div
            className="grid size-14 shrink-0 place-items-center rounded-full border border-primary/25 bg-primary/10 font-mono text-lg font-semibold text-primary"
            aria-hidden="true"
          >
            {initials(profile.name)}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{profile.name}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">{profile.email}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Avatar uploads are not enabled on this platform yet — your initials are shown instead.
            </p>
          </div>
        </div>

        <form onSubmit={(event) => void submit(event)} className="grid gap-4 sm:grid-cols-2">
          <Field label="Email" hint="Contact support to change your sign-in email.">
            <input value={profile.email} readOnly className={INPUT_CLASS} />
          </Field>
          <Field label="Display name">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="name"
              required
              minLength={2}
              maxLength={100}
              className={INPUT_CLASS}
            />
          </Field>
          <Field label="Nickname">
            <input
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              autoComplete="nickname"
              required
              minLength={2}
              maxLength={30}
              className={INPUT_CLASS}
            />
          </Field>
          <Field label="Date of birth">
            <input
              type="date"
              value={dateOfBirth}
              onChange={(event) => setDateOfBirth(event.target.value)}
              required
              max={new Date().toISOString().slice(0, 10)}
              className={INPUT_CLASS}
            />
          </Field>
          <div className="sm:col-span-2">
            <CountryCombobox
              value={country}
              onChange={(code) => {
                setCountry(code)
                setPhoneCountry(code)
              }}
            />
          </div>
          <PhoneInput country={phoneCountry} onCountryChange={setPhoneCountry} value={phoneDigits} onChange={setPhoneDigits} />
          <div className="sm:col-span-2">
            <CountryCombobox
              id="vps-country"
              label="VPS country (optional)"
              placeholder="Search country…"
              value={vpsCountry}
              onChange={setVpsCountry}
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              Declare the country of the VPS you trade from. Sign-ins from another country raise a security alert.
            </p>
          </div>

          {error ? <div className="sm:col-span-2"><Notice tone="error">{error}</Notice></div> : null}
          {saved ? <div className="sm:col-span-2"><Notice tone="success">Profile saved.</Notice></div> : null}

          <div className="flex items-center justify-between gap-3 sm:col-span-2">
            <p className="text-[11px] text-muted-foreground">Stored securely with your account.</p>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              {saving ? 'Saving…' : 'Save profile'}
            </button>
          </div>
        </form>
      </Panel>

      <KYCSection />
    </div>
  )
}
