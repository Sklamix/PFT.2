'use client'

import { useState, type FormEvent } from 'react'
import { Loader2, Save } from 'lucide-react'
import { TIMEZONE_OPTIONS, timeZoneOffsetLabel } from '@/lib/stores/useTimezoneStore'
import { DATE_FORMATS, DISPLAY_CURRENCIES, INTERFACE_LANGUAGES, NUMBER_FORMATS, formatAmount, formatDateTime } from '@/lib/settings/format'
import type { Preferences } from '@/lib/settings/format'
import { Field, Notice, Panel, SELECT_CLASS } from './ui'

export function PreferencesPanel({
  preferences,
  onSaved,
}: {
  preferences: Preferences
  onSaved: (next: Preferences) => void
}) {
  const [timeZone, setTimeZone] = useState(preferences.timeZone)
  const [dateFormat, setDateFormat] = useState(preferences.dateFormat)
  const [numberFormat, setNumberFormat] = useState(preferences.numberFormat)
  const [interfaceLanguage, setInterfaceLanguage] = useState(preferences.interfaceLanguage)
  const [displayCurrency, setDisplayCurrency] = useState(preferences.displayCurrency)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const preview = { dateFormat, numberFormat, timeZone }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const response = await fetch('/api/settings/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeZone, dateFormat, numberFormat, interfaceLanguage, displayCurrency }),
      })
      const data = (await response.json().catch(() => ({}))) as { error?: string; preferences?: Preferences }
      if (!response.ok || !data.preferences) throw new Error(data.error ?? 'Unable to save preferences.')
      onSaved(data.preferences)
      // Keep the terminal clock, calendar and chart labels in sync immediately.
      window.localStorage.setItem('pft-terminal-timezone', data.preferences.timeZone)
      window.dispatchEvent(new Event('pft-timezone-change'))
      setSaved(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save preferences.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
      <Panel
        title="Regional display"
        description="These settings change how dates, numbers and times are shown. Stored trades and balances are never modified."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Interface language" hint="English is the only interface language available in PFT today.">
            <select
              value={interfaceLanguage}
              onChange={(event) => setInterfaceLanguage(event.target.value)}
              className={SELECT_CLASS}
              disabled={INTERFACE_LANGUAGES.length <= 1}
            >
              {INTERFACE_LANGUAGES.map((language) => (
                <option key={language.value} value={language.value}>
                  {language.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Timezone" hint="Used for the terminal clock, calendar and security history.">
            <select value={timeZone} onChange={(event) => setTimeZone(event.target.value)} className={SELECT_CLASS}>
              {TIMEZONE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} {option.value === 'UTC' ? '' : `(${timeZoneOffsetLabel(option.value)})`}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Date format">
            <select value={dateFormat} onChange={(event) => setDateFormat(event.target.value)} className={SELECT_CLASS}>
              {DATE_FORMATS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Number format">
            <select value={numberFormat} onChange={(event) => setNumberFormat(event.target.value)} className={SELECT_CLASS}>
              {NUMBER_FORMATS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Display currency"
            hint="Balances and payouts are settled in USD. Display currency never converts amounts."
          >
            <select
              value={displayCurrency}
              onChange={(event) => setDisplayCurrency(event.target.value)}
              className={SELECT_CLASS}
              disabled={DISPLAY_CURRENCIES.length <= 1}
            >
              {DISPLAY_CURRENCIES.map((currency) => (
                <option key={currency.value} value={currency.value}>
                  {currency.label}
                </option>
              ))}
            </select>
          </Field>

          <div className="rounded-md border border-border/70 bg-secondary/30 p-3">
            <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Preview</p>
            <p className="mt-1 font-mono text-xs tabular-nums text-foreground">{formatDateTime(new Date(), preview)}</p>
            <p className="mt-1 font-mono text-xs tabular-nums text-foreground">$ {formatAmount(1234567.89, { numberFormat })}</p>
            <p className="mt-1 text-[10px] text-muted-foreground">Times are stored in UTC and displayed in your chosen zone.</p>
          </div>
        </div>

        {error ? <div className="mt-4"><Notice tone="error">{error}</Notice></div> : null}
        {saved ? <div className="mt-4"><Notice tone="success">Preferences saved.</Notice></div> : null}

        <div className="mt-4 flex items-center justify-between gap-3 border-t border-border/60 pt-4">
          <p className="text-[11px] text-muted-foreground">Applies across your PFT workspace.</p>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            {saving ? 'Saving…' : 'Save preferences'}
          </button>
        </div>
      </Panel>
    </form>
  )
}
