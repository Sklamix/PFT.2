'use client'

import dynamic from 'next/dynamic'
import { ArrowRight, CalendarClock, Clock, KeyRound, MousePointer2, Sparkles } from 'lucide-react'

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
  { icon: CalendarClock, label: 'Weekly payouts' },
]

const PLATFORMS = ['PFT Web Terminal']

export function Hero() {
  return (
    <section id="top" className="relative isolate min-h-[100svh] overflow-hidden border-b border-white/5 bg-background">
      {/* Background layer (z-0): dark cosmos + technical grid */}
      <div className="pointer-events-none absolute inset-0 z-0">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_78%_44%,rgba(37,99,235,0.16),transparent_34%),radial-gradient(circle_at_56%_68%,rgba(14,165,233,0.09),transparent_28%)]" />
        <div className="absolute inset-0 opacity-[0.22] [background-image:radial-gradient(#e0f2fe_1px,transparent_1px)] [background-size:42px_42px]" />
        <div className="absolute inset-0 opacity-[0.14] [background-image:linear-gradient(rgba(148,163,184,.18)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,.18)_1px,transparent_1px)] [background-size:72px_72px]" />
      </div>

      {/* Glow layer (z-10): cropped Sun + dual orange-gold flare + astronaut backlight */}
      <div className="pointer-events-none absolute inset-0 z-10">
        <div
          className="absolute -top-48 -left-48 size-[40rem] rounded-full blur-[90px]"
          style={{ background: 'radial-gradient(circle, rgba(67,136,255,0.28) 0%, rgba(85,214,232,0.12) 42%, transparent 70%)' }}
        />
        <div
          className="absolute top-[62%] left-[92%] size-[24rem] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[60px]"
          style={{ background: 'radial-gradient(circle, rgba(85,214,232,0.32) 0%, rgba(14,165,233,0.14) 40%, transparent 70%)' }}
        />
      </div>

      {/* Middle layer (z-20): Earth, orbital rings and astronaut */}
      <div className="absolute inset-0 z-20">
        <HeroSpaceScene variant="solar" />
      </div>

      {/* Legibility gradient (z-[25]): keeps the left text readable over the scene */}
      <div className="pointer-events-none absolute inset-0 z-[25] bg-[linear-gradient(90deg,rgba(7,11,22,0.86)_0%,rgba(7,11,22,0.72)_26%,rgba(7,11,22,0.3)_54%,transparent_78%)] max-lg:bg-[linear-gradient(180deg,rgb(7,11,22)_0%,rgba(7,11,22,0.82)_34%,rgba(7,11,22,0.12)_70%,rgb(7,11,22)_100%)]" />

      <div className="relative z-30 mx-auto flex min-h-[calc(100svh-4rem)] max-w-7xl flex-col justify-center px-4 pt-[clamp(4.25rem,8.5vh,7rem)] pb-[clamp(2.25rem,4.5vh,3.5rem)] sm:px-6 lg:px-8 2xl:max-w-[1600px]">
        <div className="max-w-2xl xl:max-w-3xl 2xl:max-w-[48rem]">
          <p className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-[clamp(0.55rem,0.65vw,0.8rem)] font-semibold uppercase tracking-[0.24em] text-primary shadow-[0_0_30px_-16px_rgba(59,130,246,0.9)] backdrop-blur-md">
            <Sparkles className="size-[clamp(0.8rem,1vw,1.1rem)]" />
            Funded trading · next frontier
          </p>

          <h1 className="mt-[clamp(0.85rem,min(1.4vw,1.8vh),1.5rem)] text-balance text-[clamp(3rem,min(5.2vw,8.3vh),6.75rem)] font-semibold leading-[0.92] tracking-[-0.045em] text-white">
            Trade up to
            <span className="mt-2 block text-primary">
              $200,000.
            </span>
            <span className="mt-2 block text-[0.58em] font-medium leading-tight tracking-[-0.02em] text-foreground/85">
              Keep 80% of the upside.
            </span>
          </h1>

          <p className="mt-[clamp(0.9rem,min(1.4vw,1.9vh),1.35rem)] max-w-xl text-pretty text-[clamp(1rem,1.15vw,1.35rem)] leading-[1.7] text-muted-foreground xl:max-w-2xl">
            Institutional-grade evaluations for disciplined traders. No calendar pressure, instant credentials, and
            payouts available every 7 days.
          </p>

          <ul className="mt-[clamp(0.9rem,min(1.4vw,1.9vh),1.35rem)] flex flex-wrap gap-2.5">
            {HIGHLIGHTS.map(({ icon: Icon, label }) => (
              <li
                key={label}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.035] px-[clamp(0.65rem,0.9vw,1rem)] py-[clamp(0.35rem,0.5vw,0.55rem)] text-[clamp(0.65rem,0.8vw,0.85rem)] text-foreground/85 backdrop-blur-md"
              >
                <Icon className="size-[clamp(0.8rem,1vw,1.05rem)] text-primary" aria-hidden="true" />
                {label}
              </li>
            ))}
          </ul>

          <div data-hero-cta className="mt-[clamp(1.25rem,min(1.8vw,2.7vh),1.75rem)] flex flex-col gap-3 sm:flex-row">
            <a
              href="#challenges"
              className="home-button group inline-flex h-[clamp(2.6rem,min(3.2vw,5.8vh),3.4rem)] items-center justify-center gap-2 rounded-full bg-linear-to-r from-primary to-highlight px-[clamp(1.5rem,2vw,2.4rem)] text-[clamp(0.62rem,0.75vw,0.82rem)] font-bold uppercase tracking-[0.18em] text-primary-foreground shadow-[0_0_45px_-12px_rgba(59,130,246,0.9)] transition hover:brightness-110"
            >
              Get Funded
              <ArrowRight className="size-[clamp(0.9rem,1vw,1.15rem)] transition-transform group-hover:translate-x-1" />
            </a>
            <a
              href="/auth/login"
              className="home-button inline-flex h-[clamp(2.6rem,min(3.2vw,5.8vh),3.4rem)] items-center justify-center px-2 text-sm text-muted-foreground underline-offset-4 transition hover:text-foreground hover:underline sm:px-4 self-center"
            >
              Already have credentials? Log in
            </a>
          </div>

          <div className="mt-[clamp(1rem,min(1.4vw,1.8vh),1.4rem)] flex flex-wrap items-center gap-x-5 gap-y-2 text-[clamp(0.65rem,0.75vw,0.82rem)] text-muted-foreground/85">
            <span className="inline-flex items-center gap-1.5">
              <Sparkles className="size-[clamp(0.8rem,1vw,1.05rem)] text-primary" />
              80% profit split · weekly payouts
            </span>
            <span className="hidden h-3 w-px bg-white/10 sm:block" />
            <span className="inline-flex items-center gap-1.5">
              <MousePointer2 className="size-[clamp(0.8rem,1vw,1.05rem)] text-primary" />
              Move your cursor to explore
            </span>
          </div>
        </div>

        <div className="mt-auto grid max-w-3xl grid-cols-2 gap-[clamp(0.4rem,0.6vw,0.8rem)] pt-[clamp(0.9rem,min(2.2vw,2.6vh),1.5rem)] sm:grid-cols-4 xl:max-w-4xl 2xl:max-w-5xl">
          {[
            ['$200K', 'Max simulated capital'],
            ['80%', 'Profit split'],
            ['0', 'Time limits'],
            ['1–3d', 'Payout review'],
          ].map(([value, label]) => (
            <div key={label} className="rounded-xl border border-white/10 bg-black/20 px-[clamp(0.7rem,1vw,1.1rem)] py-[clamp(0.5rem,0.7vw,0.75rem)] backdrop-blur-md">
              <p className="font-mono text-[clamp(1.1rem,1.5vw,1.8rem)] font-semibold text-white">{value}</p>
              <p className="mt-0.5 text-[clamp(0.5rem,0.6vw,0.7rem)] uppercase tracking-wider text-muted-foreground/85">{label}</p>
            </div>
          ))}
        </div>

        <div id="platforms" className="mt-[clamp(0.5rem,1vh,0.9rem)] flex flex-wrap items-center gap-2">
          <span className="text-[clamp(0.5rem,0.6vw,0.7rem)] uppercase tracking-[0.18em] text-muted-foreground/70">Platforms</span>
          {PLATFORMS.map((platform) => (
            <span
              key={platform}
              className="rounded-full border border-white/10 bg-white/[0.025] px-[clamp(0.5rem,0.7vw,0.8rem)] py-1 font-mono text-[clamp(0.5rem,0.6vw,0.7rem)] text-muted-foreground"
            >
              {platform}
            </span>
          ))}
        </div>
      </div>

    </section>
  )
}
