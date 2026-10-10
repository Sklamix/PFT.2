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
    <span className="flex size-10 items-center justify-center rounded-lg border border-border bg-background text-primary">
      <Icon className="size-5" aria-hidden="true" />
    </span>
  )
}

export function FeaturesBento() {
  return (
    <section aria-labelledby="features-heading" className="border-b border-border bg-surface py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          id="features-heading"
          eyebrow="Built for professionals"
          title="Conditions that respect your edge."
          description="Execution quality and rules designed around how real traders operate — not around how to make them fail."
        />

        <div className="mt-14 grid gap-4 lg:grid-cols-3">
          <article className="group flex flex-col gap-6 rounded-2xl border border-border bg-card p-6 transition-colors hover:border-primary/40 lg:col-span-2">
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-4">
                <FeatureIcon icon={Activity} />
                <div>
                  <h3 className="text-lg font-semibold text-foreground">Raw spreads & zero slippage</h3>
                  <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                    Direct tier-1 liquidity feeds aggregated from top-tier banks. Institutional pricing on every
                    instrument, with execution under 30ms.
                  </p>
                </div>
              </div>
              <span className="hidden rounded-full border border-highlight/30 bg-highlight/10 px-2.5 py-1 font-mono text-xs text-highlight sm:inline">
                avg. 28ms
              </span>
            </div>
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-left text-sm">
                <thead className="bg-background text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 font-medium">Instrument</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Avg. spread</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">Commission / lot</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {SPREADS.map((row) => (
                    <tr key={row.pair} className="transition-colors hover:bg-accent/40">
                      <td className="px-4 py-2.5 font-mono text-foreground">{row.pair}</td>
                      <td className="px-4 py-2.5 font-mono text-primary">{row.spread} pips</td>
                      <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">{row.commission}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>

          <article className="flex flex-col justify-between gap-6 rounded-2xl border border-border bg-card p-6 transition-colors hover:border-primary/40">
            <div className="flex flex-col gap-4">
              <FeatureIcon icon={Hourglass} />
              <div>
                <h3 className="text-lg font-semibold text-foreground">No time pressure</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  Trade at your own pace. No calendar limits on any phase — wait for your setups.
                </p>
              </div>
            </div>
            <div className="rounded-lg border border-border bg-background p-4">
              <p className="text-xs text-muted-foreground">Maximum evaluation period</p>
              <p className="mt-1 text-gradient font-mono text-4xl font-semibold">Unlimited</p>
              <div className="mt-4 grid grid-cols-7 gap-1" aria-hidden="true">
                {Array.from({ length: 21 }).map((_, index) => (
                  <span
                    key={index}
                    className={
                      [2, 5, 9, 13, 16].includes(index)
                        ? 'aspect-square rounded-sm bg-primary/70'
                        : 'aspect-square rounded-sm bg-border/70'
                    }
                  />
                ))}
              </div>
            </div>
          </article>

          <article className="flex flex-col justify-between gap-6 rounded-2xl border border-border bg-card p-6 transition-colors hover:border-primary/40">
            <div className="flex flex-col gap-4">
              <FeatureIcon icon={Wallet} />
              <div>
                <h3 className="text-lg font-semibold text-foreground">Bi-weekly & on-demand payouts</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  Request rewards every 14 days, or on-demand once you hit 5% profit. Paid out in crypto or by bank wire.
                </p>
              </div>
            </div>
            <ul className="flex flex-wrap gap-2">
              {PAYOUT_METHODS.map((method) => (
                <li
                  key={method}
                  className="rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs text-foreground"
                >
                  {method}
                </li>
              ))}
            </ul>
          </article>

          <article className="flex flex-col gap-6 rounded-2xl border border-border bg-card p-6 transition-colors hover:border-primary/40 lg:col-span-2">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex flex-col gap-4">
                <div className="flex gap-2">
                  <FeatureIcon icon={Newspaper} />
                  <FeatureIcon icon={Moon} />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-foreground">Weekend holding & news trading allowed</h3>
                  <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                    Swing positions through the weekend and trade high-impact releases without restriction windows.
                  </p>
                </div>
              </div>
              <CalendarRange className="hidden size-5 text-muted-foreground sm:block" aria-hidden="true" />
            </div>
            <ul className="divide-y divide-border rounded-lg border border-border bg-background">
              {NEWS_EVENTS.map((item) => (
                <li key={item.event} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                  <span className="flex items-center gap-3">
                    <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">{item.time}</span>
                    <span className="text-foreground">{item.event}</span>
                  </span>
                  <span
                    className={
                      item.impact === 'High'
                        ? 'shrink-0 rounded-full bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger'
                        : 'shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary'
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
