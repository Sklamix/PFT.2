'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, CalendarClock, Clock, KeyRound, MousePointerClick, Sparkles } from 'lucide-react'

import { PlanetAdvantageCard } from '@/components/home/planet-advantage-card'
import { PlanetController } from '@/components/home/planet-controller'
import { PlanetHotspots } from '@/components/home/planet-hotspots'
import { PLANET_SPOTS, type PlanetMode, type PlanetSpotId } from '@/components/home/planet-spots'
import { cn } from '@/lib/utils'

const HeroSpaceScene = dynamic(
  () => import('@/components/home/hero-space-scene').then((mod) => mod.HeroSpaceScene),
  {
    ssr: false,
    loading: () => (
      <div className="absolute inset-0 grid place-items-center">
        <div className="size-40 animate-pulse rounded-full border border-primary/20 bg-primary/5 blur-sm motion-reduce:animate-none" />
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
  const [mode, setMode] = useState<PlanetMode>('hero')
  const [activeSpotId, setActiveSpotId] = useState<PlanetSpotId | null>(null)
  const [showFirstVisitHint, setShowFirstVisitHint] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(false)
  const [planetController] = useState(() => new PlanetController())
  const lastTrigger = useRef<HTMLButtonElement | null>(null)
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const activeSpot = useMemo(
    () => PLANET_SPOTS.find((spot) => spot.id === activeSpotId) ?? null,
    [activeSpotId],
  )

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReducedMotion(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try {
        setShowFirstVisitHint(window.localStorage.getItem('pft:planet-hint-seen') !== '1')
      } catch {
        setShowFirstVisitHint(true)
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  const dismissFirstVisitHint = useCallback(() => {
    setShowFirstVisitHint(false)
    try {
      window.localStorage.setItem('pft:planet-hint-seen', '1')
    } catch {
      // The hint can still disappear for this visit when storage is unavailable.
    }
  }, [])

  const closeExplorer = useCallback((restoreFocus = true) => {
    setMode('hero')
    setActiveSpotId(null)
    if (restoreFocus) requestAnimationFrame(() => lastTrigger.current?.focus())
    else lastTrigger.current = null
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || mode === 'hero') return
      event.preventDefault()
      closeExplorer(mode === 'detail')
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [closeExplorer, mode])

  useEffect(
    () => () => {
      if (scrollTimer.current) clearTimeout(scrollTimer.current)
    },
    [],
  )

  const openSpot = useCallback((spot: PlanetSpotId, trigger: HTMLButtonElement) => {
    lastTrigger.current = trigger
    setActiveSpotId(spot)
    setMode('detail')
  }, [])

  const navigateToSection = useCallback(
    (href: `#${PlanetSpotId}`) => {
      closeExplorer(false)
      const delay = reducedMotion ? 0 : 200
      scrollTimer.current = setTimeout(() => {
        document.querySelector(href)?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' })
      }, delay)
    },
    [closeExplorer, reducedMotion],
  )

  const focused = mode !== 'hero'

  return (
    <section id="top" className="relative isolate min-h-[100svh] overflow-hidden border-b border-white/5 bg-background">
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-0 z-0 transition-[filter,opacity] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          focused && 'blur-sm opacity-55',
        )}
      >
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_78%_44%,rgba(37,99,235,0.16),transparent_34%),radial-gradient(circle_at_56%_68%,rgba(14,165,233,0.09),transparent_28%)]" />
        <div className="absolute inset-0 opacity-[0.22] [background-image:radial-gradient(#e0f2fe_1px,transparent_1px)] [background-size:42px_42px]" />
        <div className="absolute inset-0 opacity-[0.14] [background-image:linear-gradient(rgba(148,163,184,.18)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,.18)_1px,transparent_1px)] [background-size:72px_72px]" />
      </div>

      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-0 z-10 transition-[filter,opacity] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          focused && 'blur-md opacity-50',
        )}
      >
        <div
          className="absolute -top-48 -left-48 size-[40rem] rounded-full blur-[90px]"
          style={{ background: 'radial-gradient(circle, rgba(67,136,255,0.28) 0%, rgba(85,214,232,0.12) 42%, transparent 70%)' }}
        />
        <div
          className="absolute top-[62%] left-[92%] size-[24rem] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[60px]"
          style={{ background: 'radial-gradient(circle, rgba(85,214,232,0.32) 0%, rgba(14,165,233,0.14) 40%, transparent 70%)' }}
        />
      </div>

      <div className="absolute inset-0 z-20" aria-hidden="true">
        <HeroSpaceScene
          variant="solar"
          mode={mode}
          activeSpot={activeSpotId}
          reducedMotion={reducedMotion}
          controller={planetController}
        />
      </div>

      <div className="pointer-events-none absolute inset-0 z-[25] bg-[linear-gradient(90deg,rgba(7,11,22,0.86)_0%,rgba(7,11,22,0.72)_26%,rgba(7,11,22,0.3)_54%,transparent_78%)] max-lg:bg-[linear-gradient(180deg,rgb(7,11,22)_0%,rgba(7,11,22,0.82)_34%,rgba(7,11,22,0.12)_70%,rgb(7,11,22)_100%)]" />

      <div
        aria-hidden={!focused}
        className={cn(
          'absolute inset-0 z-[26] hidden transition-opacity duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] lg:block motion-reduce:transition-none',
          focused
            ? cn(
                'pointer-events-auto opacity-100',
                mode === 'detail'
                  ? 'bg-[radial-gradient(circle_at_77%_50%,transparent_0%,rgba(7,11,22,0.28)_27%,rgba(7,11,22,0.78)_72%)]'
                  : 'bg-[radial-gradient(circle_at_50%_50%,transparent_0%,rgba(7,11,22,0.25)_30%,rgba(7,11,22,0.76)_76%)]',
              )
            : 'pointer-events-none opacity-0',
        )}
        onPointerDown={() => closeExplorer(mode === 'detail')}
      />

      <div
        inert={focused}
        aria-hidden={focused}
        className={cn(
          'relative z-30 mx-auto flex min-h-[calc(100svh-4rem)] max-w-7xl flex-col justify-center px-4 pt-[clamp(4.25rem,8.5vh,7rem)] pb-[clamp(2.25rem,4.5vh,3.5rem)] transition-[opacity,transform] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] sm:px-6 lg:px-8 2xl:max-w-[1600px] motion-reduce:transition-none',
          focused && 'pointer-events-none translate-y-3 opacity-0',
        )}
      >
        <div className="max-w-2xl xl:max-w-3xl 2xl:max-w-[48rem]">
          <p className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-[clamp(0.55rem,0.65vw,0.8rem)] font-semibold uppercase tracking-[0.24em] text-primary shadow-[0_0_30px_-16px_rgba(59,130,246,0.9)] backdrop-blur-md">
            <Sparkles className="size-[clamp(0.8rem,1vw,1.1rem)]" />
            Funded trading · next frontier
          </p>

          <h1 className="mt-[clamp(0.85rem,min(1.4vw,1.8vh),1.5rem)] text-balance text-[clamp(3rem,min(5.2vw,8.3vh),6.75rem)] leading-[0.92] font-semibold tracking-[-0.04em] text-white">
            Trade up to
            <span className="mt-2 block text-primary">$200,000.</span>
            <span className="mt-2 block text-[0.58em] leading-tight font-medium tracking-[-0.02em] text-foreground/85">
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
              className="home-button inline-flex h-[clamp(2.6rem,min(3.2vw,5.8vh),3.4rem)] items-center justify-center self-center px-2 text-sm text-muted-foreground underline-offset-4 transition hover:text-foreground hover:underline sm:px-4"
            >
              Already have credentials? Log in
            </a>
          </div>

          <div className="mt-[clamp(1rem,min(1.4vw,1.8vh),1.4rem)] flex flex-wrap items-center gap-x-5 gap-y-2 text-[clamp(0.65rem,0.75vw,0.82rem)] text-muted-foreground/85">
            <span className="inline-flex items-center gap-1.5">
              <Sparkles className="size-[clamp(0.8rem,1vw,1.05rem)] text-primary" />
              80% profit split · weekly payouts
            </span>
            <span className="hidden h-3 w-px bg-white/10 lg:block" />
            <span className="hidden items-center gap-1.5 lg:inline-flex">
              <MousePointerClick className="size-[clamp(0.8rem,1vw,1.05rem)] text-primary" />
              Drag the planet · click a marker
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

      <PlanetHotspots
        mode={mode}
        activeSpot={activeSpotId}
        showFirstVisitHint={showFirstVisitHint}
        controller={planetController}
        onPlanetClick={() => {
          dismissFirstVisitHint()
          if (mode === 'hero') setMode('focus')
        }}
        onOpenSpot={openSpot}
        onInteract={dismissFirstVisitHint}
      />

      <div
        inert={mode !== 'detail'}
        aria-hidden={mode !== 'detail'}
        className={cn(
          'pointer-events-none absolute inset-0 z-[45] hidden transition-[opacity,transform] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] lg:block motion-reduce:transition-none',
          mode === 'detail' ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0',
        )}
      >
        {activeSpot ? (
          <div className="mx-auto flex min-h-[calc(100svh-4rem)] max-w-7xl items-center px-4 pt-16 sm:px-6 lg:px-8 2xl:max-w-[1600px]">
            <div className="pointer-events-auto w-full max-w-[520px]" onPointerDown={(event) => event.stopPropagation()}>
              <PlanetAdvantageCard spot={activeSpot} onClose={() => closeExplorer(true)} onNavigate={navigateToSection} />
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}
