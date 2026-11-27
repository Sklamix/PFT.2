'use client'

import { useState, type FormEvent } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Field, Notice, Panel } from './ui'
import type { Preferences } from '@/lib/settings/format'

export function TradingPanel({
  preferences,
  onSaved,
}: {
  preferences: Preferences
  onSaved: (next: Preferences) => void
}) {
  const [enabled, setEnabled] = useState(preferences.advancedOrderTypes)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const response = await fetch('/api/settings/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ advancedOrderTypes: enabled }),
      })
      const data = (await response.json().catch(() => ({}))) as { error?: string; preferences?: Preferences }
      if (!response.ok || !data.preferences) throw new Error(data.error ?? 'Unable to save preferences.')
      setEnabled(data.preferences.advancedOrderTypes)
      onSaved(data.preferences)
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
        title="Order ticket"
        description="Stop & Stop-Limit orders are shown in the Pending tab of the order ticket. Limit orders stay available either way."
      >
        <Field
          label="Stop & Stop-Limit orders"
          hint="Show STOP and STOP-LIMIT in the Pending tab of the order ticket. Limit orders stay available either way."
        >
          <button
            type="button"
            onClick={() => void setEnabled(!enabled)}
            aria-pressed={enabled}
            aria-label={enabled ? 'Disable Stop & Stop-Limit orders' : 'Enable Stop & Stop-Limit orders'}
            className={cn(
              'relative inline-flex size-6 cursor-pointer rounded-full bg-primary transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              enabled ? 'bg-primary' : 'bg-secondary/40',
            )}
          >
            <span
              className={cn(
                'inline-flex size-3.5 rounded-full bg-white transition-transform duration-200',
                enabled ? 'translate-x-3' : 'translate-x-0.5',
              )}
              aria-hidden="true"
            >
              {enabled && <Check className="size-2.5" aria-hidden="true" />}
            </span>
          </button>
        </Field>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Applies to your account, not to this browser. Existing working orders are not affected.
        </p>

        {error ? <div className="mt-4"><Notice tone="error">{error}</Notice></div> : null}
        {saved ? <div className="mt-4"><Notice tone="success">Settings saved.</Notice></div> : null}

        <div className="mt-4 flex items-center justify-between gap-3 border-t border-border/60 pt-4">
          <p className="text-[11px] text-muted-foreground">Stored with your profile, applies on every device.</p>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </Panel>
    </form>
  )
}
