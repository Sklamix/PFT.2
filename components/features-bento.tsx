import { Activity, CalendarRange, Hourglass, Wallet, Newspaper, Moon } from 'lucide-react'
import { SectionHeading } from '@/components/section-heading'

const SPREADS = [
  { pair: 'EUR/USD', spread: '0.0', commission: '$3' },
  { pair: 'GBP/USD', spread: '0.1', commission: '$3' },
  { pair: 'XAU/USD', spread: '0.8', commission: '$3' },
  { pair: 'NAS100', spread: '0.4', commission: '$0' },
]

const PAYOUT_METHODS = ['USDT', 'USDC', 'Bank Wire']

const NEWS_EVENTS = [
  { time: '08:30', event: 'US Non-Farm Payrolls', impact: 'High' },
  { time: '14:00', event: 'FOMC Rate Decision', impact: 'High' },
  { time: 'Fri 22:00', event: 'Weekend hold — positions open', impact: 'Allowed' },
]

function FeatureIcon({ icon: Icon }: { icon: typeof Activity }) {
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
          <article className="home-card cosmic-card flex flex-col gap-6 rounded-[1.75rem] p-6 lg:col-span-2">
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-4">
                <FeatureIcon icon={Activity} />
                <div>
                  <h3 className="text-lg font-semibold text-white sm:text-xl">Raw spreads & zero slippage</h3>
                  <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-400">
                    Direct tier-1 liquidity feeds aggregated from top-tier banks. Institutional pricing on every
                    instrument, with execution under 30ms.
                  </p>
                </div>
              </div>
              <span className="hidden rounded-full border border-highlight/30 bg-highlight/10 px-2.5 py-1 font-mono text-xs text-highlight sm:inline">
                avg. 28ms
              </span>
            </div>
            <div className="overflow-hidden rounded-xl border border-white/10 bg-black/25">
              <table className="w-full text-left text-xs sm:text-sm">
                <thead className="bg-white/[0.035] text-[10px] uppercase tracking-[0.14em] text-slate-500">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 font-medium">Instrument</th>
                    <th scope="col" className="whitespace-nowrap px-4 py-2.5 font-medium">Avg. spread</th>
                    <th scope="col" className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">Commission / lot</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06]">
                  {SPREADS.map((row) => (
                    <tr key={row.pair} className="transition-colors hover:bg-white/[0.035]">
                      <td className="px-4 py-2.5 font-mono text-white">{row.pair}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-primary">{row.spread} pips</td>
                      <td className="hidden px-4 py-2.5 text-right font-mono text-slate-400 sm:table-cell">{row.commission}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>

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
                <h3 className="text-lg font-semibold text-white sm:text-xl">Bi-weekly & on-demand payouts</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">
                  Request rewards every 14 days, or on-demand once you hit 5% profit. Paid out in crypto or by bank wire.
                </p>
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/25 p-3.5">
              <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.14em]">
                <span className="text-slate-500">Payout cycle</span>
                <span className="font-mono text-primary">14 days</span>
              </div>
              <div className="mt-3 grid grid-cols-7 gap-1" aria-hidden="true">
                {Array.from({ length: 14 }).map((_, index) => (
                  <span
                    key={index}
                    className={
                      index < 10
                        ? 'h-1.5 rounded-full bg-primary/70 shadow-[0_0_8px_rgba(59,130,246,0.35)]'
                        : 'h-1.5 rounded-full bg-white/[0.07]'
                    }
                  />
                ))}
              </div>
              <div className="mt-2 flex items-center justify-between text-[9px] text-slate-600">
                <span>Day 0</span>
                <span className="text-slate-500">On-demand from +5%</span>
                <span>Day 14</span>
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

          <article className="home-card cosmic-card flex flex-col gap-6 rounded-[1.75rem] p-6 lg:col-span-2">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex flex-col gap-4">
                <div className="flex gap-2">
                  <FeatureIcon icon={Newspaper} />
                  <FeatureIcon icon={Moon} />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-white sm:text-xl">Weekend holding & news trading allowed</h3>
                  <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-400">
                    Swing positions through the weekend and trade high-impact releases without restriction windows.
                  </p>
                </div>
              </div>
              <CalendarRange className="hidden size-5 text-slate-600 sm:block" aria-hidden="true" />
            </div>
            <ul className="divide-y divide-white/[0.06] rounded-xl border border-white/10 bg-black/25">
              {NEWS_EVENTS.map((item) => (
                <li key={item.event} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                  <span className="flex items-center gap-3">
                    <span className="w-16 shrink-0 font-mono text-xs text-slate-500">{item.time}</span>
                    <span className="text-slate-200">{item.event}</span>
                  </span>
                  <span
                    className={
                      item.impact === 'High'
                        ? 'shrink-0 rounded-full border border-danger/20 bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger'
                        : 'shrink-0 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary'
                    }
                  >
                    {item.impact === 'High' ? 'High impact · Tradable' : item.impact}
                  </span>
                </li>
              ))}
            </ul>
          </article>
        </div>
      </div>
    </section>
  )
}
