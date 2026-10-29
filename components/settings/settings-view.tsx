'use client'

import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Loader2, SlidersHorizontal, UserRound } from 'lucide-react'
import { SpaceBackground } from '@/components/dashboard/space-background'
import { cn } from '@/lib/utils'
import { SecurityPanel } from './security-panel'
import { PreferencesPanel } from './preferences-panel'
import { ProfilePanel } from './profile-panel'
import { Notice } from './ui'

type Section = 'profile' | 'security' | 'preferences'

type SettingsPayload = {
  profile: {
    email: string
    name: string
    nickname: string | null
    avatarUrl: string | null
    kycStatus: string
    emailVerified: boolean
  }
  preferences: {
    interfaceLanguage: string
    dateFormat: string
    numberFormat: string
    displayCurrency: string
    timeZone: string
  }
  security: {
    singleSessionModel: boolean
    lastSignInAt: string | null
    lastSignInLabel: string | null
    lastSignInIp: string | null
    lastSignInCountry: string | null
    lastDevice: string | null
    lastPasswordChangedAt: string | null
    lastPasswordChangedLabel: string | null
    twoFactorEnabled: boolean
    twoFactorSupported: boolean
  }
  history: {
    signIns: { id: string; ip: string | null; country: string | null; device: string | null; at: string; label: string }[]
    events: { id: string; action: string; reason: string | null; at: string; label: string }[]
  }
}

const SECTIONS = [
  { id: 'profile', label: 'Profile', shortLabel: 'Profile', icon: UserRound, description: 'Identity and contact details' },
  { id: 'security', label: 'Security', shortLabel: 'Security', icon: KeyRound, description: 'Password, sessions and history' },
  {
    id: 'preferences',
    label: 'Platform Preferences',
    shortLabel: 'Preferences',
    icon: SlidersHorizontal,
    description: 'Language, timezone and formats',
  },
] as const

export function SettingsView() {
  const [section, setSection] = useState<Section>('profile')
  const [data, setData] = useState<SettingsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/settings', { cache: 'no-store' })
      if (response.status === 401) {
        window.location.assign('/auth/login?next=/dashboard/settings')
        return
      }
      const payload = (await response.json().catch(() => ({}))) as SettingsPayload & { error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Unable to load settings.')
      setData(payload)
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load settings.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="min-h-dvh">
      <SpaceBackground />
      <div className="relative z-10 mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <header>
          <h1 className="text-lg font-semibold tracking-tight text-slate-100">Settings</h1>
          <p className="mt-1 text-sm text-[#94A3B8]">Manage your trader identity, account security and display preferences.</p>
        </header>

        <div className="mt-6 grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
          <nav aria-label="Settings sections" className="lg:sticky lg:top-6 lg:self-start">
            <ul className="flex gap-1 overflow-x-auto rounded-xl border border-slate-800/80 bg-[#0B0F19]/80 p-1.5 backdrop-blur-md lg:flex-col lg:gap-0.5 lg:overflow-visible">
              {SECTIONS.map((item) => {
                const Icon = item.icon
                const active = section === item.id
                return (
                  <li key={item.id} className="min-w-0 flex-1 lg:flex-none">
                    <button
                      type="button"
                      onClick={() => setSection(item.id)}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'group relative flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                        active ? 'bg-primary/10 text-slate-100' : 'text-[#94A3B8] hover:bg-slate-800/40 hover:text-slate-200',
                      )}
                    >
                      {active ? (
                        <span className="absolute inset-y-1.5 left-0 hidden w-0.5 rounded-full bg-linear-to-b from-primary to-nebula-violet shadow-[0_0_8px_rgba(67,136,255,0.8)] lg:block" aria-hidden="true" />
                      ) : null}
                      <Icon className={cn('size-4 shrink-0', active ? 'text-primary' : 'text-[#94A3B8]')} aria-hidden="true" />
                      <span className="truncate">
                        <span className="sm:hidden">{item.shortLabel}</span>
                        <span className="hidden sm:inline">{item.label}</span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
            <p className="mt-3 hidden px-1 text-[11px] leading-relaxed text-slate-500 lg:block">
              {SECTIONS.find((item) => item.id === section)?.description}
            </p>
          </nav>

          <div className="min-w-0">
            {loading ? (
              <div className="flex items-center gap-2 rounded-xl border border-slate-800/80 bg-[#0B0F19]/80 p-6 text-sm text-[#94A3B8]">
                <Loader2 className="size-4 animate-spin" /> Loading settings…
              </div>
            ) : error && !data ? (
              <Notice tone="error">{error}</Notice>
            ) : data ? (
              <>
                {error ? <div className="mb-4"><Notice tone="error">{error}</Notice></div> : null}
                {section === 'profile' ? <ProfilePanel onProfileChange={() => void load()} /> : null}
                {section === 'security' ? (
                  <SecurityPanel
                    security={data.security}
                    signIns={data.history.signIns}
                    events={data.history.events}
                    onReload={() => void load()}
                  />
                ) : null}
                {section === 'preferences' ? (
                  <PreferencesPanel preferences={data.preferences} onSaved={() => void load()} />
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
