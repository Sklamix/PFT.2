'use client'

import dynamic from 'next/dynamic'
import { ArrowRight, CalendarClock, Clock, KeyRound, MousePointer2, Sparkles, Star } from 'lucide-react'
import { cn } from '@/lib/utils'

const HeroSpaceScene = dynamic(
  () => import('@/components/home/hero-space-scene').then((mod) => mod.HeroSpaceScene),
  {
    ssr: false,
    loading: () => (
      <div className="absolute inset-0 grid place-items-center">
        <div className="size-40 animate-pulse rounded-full border border-primary/20 bg-primary/5 blur-sm" />
      </div>
    ),
  },
)

const HIGHLIGHTS = [
  { icon: Clock, label: 'Zero time limits' },
  { icon: KeyRound, label: 'Instant credentials' },
  { icon: CalendarClock, label: 'Bi-weekly payouts' },
]

const PLATFORMS = ['MT4', 'MT5', 'cTrader', 'DXtrade']

export function Hero() {
  return (
    <section id="top" className="relative isolate min-h-[100svh] overflow-hidden border-b border-white/5 bg-[#02040a]">
      <div className="pointer-events-none absolute inset-0 z-0">
        <div className="absolute -left-52 top-1/2 size-[42rem] -translate-y-1/2 rounded-full bg-amber-300/30 blur-[90px]" />
        <div
          className="absolute -left-24 top-1/2 size-[34rem] -translate-y-1/2 rounded-full opacity-90 blur-2xl"
          style={{ background: 'radial-gradient(circle, rgba(255,190,92,0.58) 0%, rgba(255,122,26,0.22) 40%, transparent 70%)' }}
        />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_78%_44%,rgba(37,99,235,0.16),transparent_34%),radial-gradient(circle_at_56%_68%,rgba(14,165,233,0.09),transparent_28%)]" />
        <div className="absolute inset-0 opacity-[0.22] [background-image:radial-gradient(#e0f2fe_1px,transparent_1px)] [background-size:42px_42px]" />
        <div className="absolute inset-0 opacity-[0.14] [background-image:linear-gradient(rgba(148,163,184,.18)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,.18)_1px,transparent_1px)] [background-size:72px_72px]" />
      </div>

      <div className="absolute inset-0 z-10">
        <HeroSpaceScene variant="solar" />
      </div>

      <div className="pointer-events-none absolute inset-0 z-20 bg-[linear-gradient(90deg,rgba(2,4,10,0.84)_0%,rgba(2,4,10,0.78)_26%,rgba(2,4,10,0.36)_54%,transparent_80%)] max-lg:bg-[linear-gradient(180deg,#02040a_0%,rgba(2,4,10,0.82)_34%,rgba(2,4,10,0.12)_70%,#02040a_100%)]" />
      <div
        className="pointer-events-none absolute top-1/2 -left-64 z-20 size-[30rem] -translate-y-1/2 rounded-full opacity-80 blur-2xl mix-blend-screen"
        style={{ background: 'radial-gradient(circle, rgba(255,190,92,0.6) 0%, rgba(255,122,26,0.22) 42%, transparent 70%)' }}
      />

      <div className="relative z-30 mx-auto flex min-h-[100svh] max-w-7xl flex-col justify-center px-4 pt-24 pb-20 sm:px-6 sm:pt-28 lg:px-8">
        <div className="max-w-2xl">
          <p className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.24em] text-primary shadow-[0_0_30px_-16px_rgba(59,130,246,0.9)] backdrop-blur-md">
            <Sparkles className="size-3.5" />
            Funded trading · next frontier
          </p>

          <h1 className="mt-7 text-balance text-5xl font-semibold leading-[0.95] tracking-[-0.04em] text-white sm:text-6xl lg:text-7xl">
            Trade up to
            <span className="mt-2 block bg-linear-to-r from-primary via-sky-300 to-highlight bg-clip-text text-transparent">
              $400,000.
            </span>
            <span className="mt-2 block text-[0.58em] font-medium leading-tight tracking-[-0.02em] text-slate-300">
              Keep up to 90% of the upside.
            </span>
          </h1>

          <p className="mt-6 max-w-xl text-pretty text-base leading-7 text-slate-400 sm:text-lg">
            Institutional-grade evaluations for disciplined traders. No calendar pressure, instant credentials, and
            payouts processed every two weeks.
          </p>

          <ul className="mt-6 flex flex-wrap gap-2.5">
            {HIGHLIGHTS.map(({ icon: Icon, label }) => (
              <li
                key={label}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5 text-xs text-slate-300 backdrop-blur-md"
              >
                <Icon className="size-3.5 text-primary" aria-hidden="true" />
                {label}
              </li>
            ))}
          </ul>

          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <a
              href="#challenges"
              className="home-button group inline-flex h-12 items-center justify-center gap-2 rounded-full bg-linear-to-r from-primary to-highlight px-7 text-xs font-bold uppercase tracking-[0.18em] text-primary-foreground shadow-[0_0_45px_-12px_rgba(59,130,246,0.9)] transition hover:brightness-110"
            >
              Get Funded
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
            </a>
            <a
              href="/auth/login"
              className="home-button inline-flex h-12 items-center justify-center gap-2 rounded-full border border-white/15 bg-white/[0.035] px-7 text-xs font-bold uppercase tracking-[0.18em] text-white backdrop-blur-md transition hover:border-primary/50 hover:bg-primary/10"
            >
              Get Started
              <ArrowRight className="size-4 text-primary transition-transform group-hover:translate-x-1" />
            </a>
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1.5">
              <span className="flex gap-0.5" aria-hidden="true">
                {Array.from({ length: 5 }).map((_, index) => (
                  <Star key={index} className={cn('size-3', index < 4 ? 'fill-primary text-primary' : 'fill-slate-700 text-slate-700')} />
                ))}
              </span>
              <span className="font-semibold text-slate-300">4.8/5</span> · 3,200+ reviews
            </span>
            <span className="hidden h-3 w-px bg-white/10 sm:block" />
            <span className="inline-flex items-center gap-1.5">
              <MousePointer2 className="size-3.5 text-primary" />
              Move your cursor to explore
            </span>
          </div>
        </div>

        <div className="mt-auto grid max-w-3xl grid-cols-2 gap-2 pt-14 sm:grid-cols-4">
          {[
            ['$400K', 'Max simulated capital'],
            ['90%', 'Profit split'],
            ['0', 'Time limits'],
            ['8h', 'Avg. payout'],
          ].map(([value, label]) => (
            <div key={label} className="rounded-xl border border-white/10 bg-black/20 px-3 py-3 backdrop-blur-md">
              <p className="font-mono text-lg font-semibold text-white">{value}</p>
              <p className="mt-0.5 text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
            </div>
          ))}
        </div>

        <div id="platforms" className="mt-5 flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase tracking-[0.18em] text-slate-600">Platforms</span>
          {PLATFORMS.map((platform) => (
            <span
              key={platform}
              className="rounded-full border border-white/10 bg-white/[0.025] px-2.5 py-1 font-mono text-[10px] text-slate-400"
            >
              {platform}
            </span>
          ))}
        </div>
      </div>

    </section>
  )
}
