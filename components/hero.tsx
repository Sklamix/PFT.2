import { ArrowRight, Clock, MessageCircle, Star, Timer, KeyRound, CalendarClock } from 'lucide-react'

const PLATFORMS = ['MT4', 'MT5', 'cTrader', 'DXtrade']

const HIGHLIGHTS = [
  { icon: Timer, label: 'Zero time limits' },
  { icon: KeyRound, label: 'Instant credentials' },
  { icon: CalendarClock, label: 'Bi-weekly payouts' },
]

function TrustpilotRating() {
  return (
    <div className="flex items-center gap-3">
      <div className="flex gap-0.5" aria-hidden="true">
        {Array.from({ length: 5 }).map((_, index) => (
          <span
            key={index}
            className={index < 4 ? 'flex size-5 items-center justify-center bg-primary' : 'relative flex size-5 items-center justify-center overflow-hidden bg-border'}
          >
            {index === 4 && <span className="absolute inset-y-0 left-0 w-4/5 bg-primary" />}
            <Star className="relative size-3 fill-primary-foreground text-primary-foreground" />
          </span>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        <span className="font-semibold text-foreground">4.8/5</span> on Trustpilot
        <span className="sr-only">, rated 4.8 out of 5 stars</span>
        <span className="hidden sm:inline"> · 3,200+ reviews</span>
      </p>
    </div>
  )
}

export function Hero() {
  return (
    <section id="top" className="relative overflow-hidden border-b border-border">
      <div className="bg-grid pointer-events-none absolute inset-0 mask-[radial-gradient(ellipse_70%_60%_at_50%_0%,#000_40%,transparent_100%)]" />
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[900px] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />

      <div className="relative mx-auto max-w-7xl px-4 pt-20 pb-16 sm:px-6 sm:pt-28 lg:px-8 lg:pb-24">
        <div className="mx-auto max-w-4xl text-center">
          <a
            href="#dashboard"
            className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 py-1 pr-3 pl-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
          >
            <span className="rounded-full bg-primary/15 px-2 py-0.5 font-medium text-primary">New</span>
            Trader portal v2 with real-time risk buffers
            <ArrowRight className="size-3" />
          </a>

          <h1 className="mt-6 text-balance text-4xl font-semibold tracking-tight text-foreground sm:text-5xl lg:text-6xl">
            Trade up to <span className="text-gradient">$400,000</span> in simulated capital. Keep up to{' '}
            <span className="text-gradient">90%</span> of your profits.
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
            Institutional-grade evaluations built for disciplined traders. No calendar pressure, credentials delivered the
            moment you check out, and payouts processed every two weeks.
          </p>

          <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            {HIGHLIGHTS.map(({ icon: Icon, label }) => (
              <li key={label} className="flex items-center gap-2 text-sm text-foreground">
                <Icon className="size-4 text-primary" aria-hidden="true" />
                {label}
              </li>
            ))}
          </ul>

          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href="#challenges"
              className="group inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-linear-to-r from-primary to-highlight px-6 text-sm font-semibold text-primary-foreground shadow-[0_0_40px_-10px] shadow-primary transition-opacity hover:opacity-90 sm:w-auto"
            >
              Choose Challenge
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </a>
            <a
              href="https://discord.com"
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg border border-border bg-card/60 px-6 text-sm font-medium text-foreground transition-colors hover:border-highlight/50 hover:bg-accent sm:w-auto"
            >
              <MessageCircle className="size-4 text-highlight" />
              Join Discord Community
            </a>
          </div>
        </div>

        <div
          id="platforms"
          className="mx-auto mt-16 grid max-w-5xl gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3"
        >
          <div className="flex flex-col gap-3 bg-card/80 p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Supported platforms</p>
            <ul className="flex flex-wrap gap-2">
              {PLATFORMS.map((platform) => (
                <li
                  key={platform}
                  className="rounded-md border border-border bg-background px-2.5 py-1 font-mono text-xs text-foreground"
                >
                  {platform}
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col gap-3 bg-card/80 p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Payout turnaround</p>
            <div className="flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-md bg-highlight/10 text-highlight">
                <Clock className="size-4" />
              </span>
              <p className="text-sm text-muted-foreground">
                <span className="block text-lg font-semibold text-foreground">8-hour average</span>
                from request to wallet
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-3 bg-card/80 p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Trader reviews</p>
            <TrustpilotRating />
          </div>
        </div>
      </div>
    </section>
  )
}
