import { Hourglass, Wallet, type LucideIcon } from 'lucide-react'
import { NewsTradingCard } from '@/components/news-trading-card'
import { SectionHeading } from '@/components/section-heading'
import { TradingConditionsCard } from '@/components/trading-conditions-card'

const PAYOUT_METHODS = ['USDT', 'USDC', 'Bank Wire']

function FeatureIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex size-10 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary shadow-[inset_0_0_20px_rgba(59,130,246,0.12)]">
      <Icon className="size-5" aria-hidden="true" />
    </span>
  )
}

export function FeaturesBento() {
  return (
    <section
      aria-labelledby="features-heading"
      data-home-reveal
      className="relative overflow-hidden border-b border-white/5 py-24 sm:py-32"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_75%_5%,rgba(6,182,212,0.14),transparent_48%)]" />
      <div className="pointer-events-none absolute -right-40 top-24 size-[30rem] rounded-full bg-highlight/10 blur-[120px]" />
      <div className="pointer-events-none absolute inset-0 cosmic-stars opacity-50" />

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 2xl:max-w-[1600px]">
        <SectionHeading
          id="features-heading"
          eyebrow="Built for professionals"
          title="Conditions that respect your edge."
          description="Execution quality and rules designed around how real traders operate — not around how to make them fail."
        />

        <div className="mt-14 grid gap-4 lg:grid-cols-3">
          <TradingConditionsCard />

          <article className="home-card cosmic-card flex flex-col justify-between gap-6 rounded-[1.75rem] p-6">
            <div className="flex flex-col gap-4">
              <FeatureIcon icon={Hourglass} />
              <div>
                <h3 className="text-lg font-semibold text-white sm:text-xl">No time pressure</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">
                  Trade at your own pace. No calendar limits on any phase — wait for your setups.
                </p>
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/25 p-4">
              <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">Maximum evaluation period</p>
              <p className="mt-1 text-gradient font-mono text-4xl font-semibold">Unlimited</p>
              <div className="mt-4 grid grid-cols-7 gap-1" aria-hidden="true">
                {Array.from({ length: 21 }).map((_, index) => (
                  <span
                    key={index}
                    className={
                      [2, 5, 9, 13, 16].includes(index)
                        ? 'aspect-square rounded-sm bg-primary/80 shadow-[0_0_12px_rgba(59,130,246,0.45)]'
                        : 'aspect-square rounded-sm bg-white/[0.06]'
                    }
                  />
                ))}
              </div>
            </div>
          </article>

          <article className="home-card cosmic-card flex flex-col justify-between gap-6 rounded-[1.75rem] p-6">
            <div className="flex flex-col gap-4">
              <FeatureIcon icon={Wallet} />
              <div>
                <h3 className="text-lg font-semibold text-white sm:text-xl">Weekly payouts</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">
                  Request rewards once every 7 days. No on-demand or early +5% payouts. Paid out in crypto or by bank wire.
                </p>
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/25 p-3.5">
              <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.14em]">
                <span className="text-slate-500">Payout cycle</span>
                <span className="font-mono text-primary">7 days</span>
              </div>
              <div className="mt-3 grid grid-cols-7 gap-1" aria-hidden="true">
                {Array.from({ length: 7 }).map((_, index) => (
                  <span
                    key={index}
                    className={
                      index < 5
                        ? 'h-1.5 rounded-full bg-primary/70 shadow-[0_0_8px_rgba(59,130,246,0.35)]'
                        : 'h-1.5 rounded-full bg-white/[0.07]'
                    }
                  />
                ))}
              </div>
              <div className="mt-2 flex items-center justify-between text-[9px] text-slate-600">
                <span>Day 0</span>
                <span className="text-slate-500">One request per 7 days</span>
                <span>Day 7</span>
              </div>
            </div>
            <ul className="flex flex-wrap gap-2">
              {PAYOUT_METHODS.map((method) => (
                <li
                  key={method}
                  className="rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5 font-mono text-xs text-slate-300"
                >
                  {method}
                </li>
              ))}
            </ul>
          </article>

          <NewsTradingCard />
        </div>
      </div>
    </section>
  )
}
