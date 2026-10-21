import type { ReactNode } from 'react'
import { BrandLogo } from '@/components/brand-logo'
import { resolveSafeNextPath } from '@/lib/auth/safe-next-path'

export function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="dark flex min-h-dvh items-center justify-center bg-[#090D16] px-4 text-foreground">
      <div className="w-full max-w-sm rounded-xl border border-border bg-[#0F172A] p-6 shadow-[0_0_40px_-20px] shadow-primary/40">
        <BrandLogo href="/" />
        <h1 className="mt-5 text-lg font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        {children}
      </div>
    </div>
  )
}

export function AuthField(props: {
  label: string
  type: string
  value: string
  onChange: (value: string) => void
  autoComplete?: string
  minLength?: number
}) {
  return (
    <label className="mt-4 block text-xs text-muted-foreground">
      {props.label}
      <input
        type={props.type}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        autoComplete={props.autoComplete}
        minLength={props.minLength}
        className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
        required
      />
    </label>
  )
}

/** Only same-origin relative paths are allowed as post-login redirects. */
export function safeNextPath(fallback = '/dashboard/terminal') {
  if (typeof window === 'undefined') return fallback
  const next = new URLSearchParams(window.location.search).get('next')
  return resolveSafeNextPath(next, window.location.origin, fallback)
}
