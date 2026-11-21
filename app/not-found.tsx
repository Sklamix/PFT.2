import Link from 'next/link'

import { BrandLogo } from '@/components/brand-logo'
import { KineticOrbit } from '@/components/auth/kinetic-orbit'

export default function NotFound() {
  return (
    <main className="relative min-h-dvh overflow-hidden bg-background text-foreground">
      <div className="absolute inset-0 opacity-[0.12] [background-image:linear-gradient(rgba(255,255,255,.08)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.08)_1px,transparent_1px)] [background-size:72px_72px]" aria-hidden="true" />
      <div className="absolute -top-32 right-[-10%] size-[28rem]" aria-hidden="true">
        <KineticOrbit />
      </div>

      <div className="relative z-10 mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-6 py-10 sm:px-12">
        <BrandLogo href="/" />

        <div className="flex flex-1 flex-col items-start justify-center py-16">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.24em] text-primary">Route not found</p>
          <p className="mt-4 font-mono text-7xl font-semibold tracking-tight text-foreground sm:text-8xl">
            4<span className="text-gradient">0</span>4
          </p>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            This page is off the chart.
          </h1>
          <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
            The link you followed does not exist, or the page has been moved. Your account, terminal and all open
            positions are safe — nothing was touched.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/dashboard"
              className="inline-flex h-11 items-center rounded-lg bg-primary px-5 text-sm font-bold text-primary-foreground shadow-[0_0_45px_-14px_rgba(67,136,255,0.9)] transition hover:brightness-110"
            >
              Go to the terminal
            </Link>
            <Link
              href="/"
              className="inline-flex h-11 items-center rounded-lg border border-border px-5 text-sm font-medium text-foreground transition hover:border-primary/50 hover:bg-primary/10"
            >
              Back to home
            </Link>
          </div>
        </div>

        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground/60">
          Professional Funded Trader — error 404
        </p>
      </div>
    </main>
  )
}
