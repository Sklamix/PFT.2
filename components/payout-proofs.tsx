import { BadgeCheck } from 'lucide-react'

const PAYOUTS = [
  { trader: 'Marcus T.', country: 'UK', amount: '$12,480', method: 'USDT', account: '$200K' },
  { trader: 'Aiko S.', country: 'JP', amount: '$4,210', method: 'Bank Wire', account: '$50K' },
  { trader: 'Daniel R.', country: 'DE', amount: '$28,950', method: 'USDC', account: '$400K' },
  { trader: 'Priya N.', country: 'IN', amount: '$2,870', method: 'USDT', account: '$25K' },
  { trader: 'Lucas M.', country: 'BR', amount: '$9,640', method: 'Bank Wire', account: '$100K' },
  { trader: 'Omar K.', country: 'AE', amount: '$16,300', method: 'USDC', account: '$200K' },
  { trader: 'Sofia L.', country: 'ES', amount: '$1,150', method: 'USDT', account: '$10K' },
  { trader: 'Ethan W.', country: 'US', amount: '$7,425', method: 'Bank Wire', account: '$100K' },
]

const STATS = [
  { value: '$38.6M+', label: 'Total rewards paid' },
  { value: '14,900+', label: 'Funded traders' },
  { value: '8 hrs', label: 'Avg. payout time' },
  { value: '170+', label: 'Countries served' },
]

function PayoutCard({ payout }: { payout: (typeof PAYOUTS)[number] }) {
  return (
    <li className="home-card flex w-72 shrink-0 items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 font-mono text-xs text-primary">
        {payout.country}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 text-sm font-medium text-foreground">
          {payout.trader}
          <BadgeCheck className="size-3.5 text-highlight" aria-label="Verified payout" />
        </p>
        <p className="text-xs text-muted-foreground">
          {payout.account} account · {payout.method}
        </p>
      </div>
      <p className="font-mono text-sm font-semibold tabular-nums text-primary">{payout.amount}</p>
    </li>
  )
}

export function PayoutProofs() {
  return (
    <section id="payouts" data-home-reveal className="border-b border-border bg-surface py-14">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="font-mono text-xs uppercase tracking-widest text-primary">Payout proofs</p>
            <h2 id="payouts-heading" className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
              Verified rewards, paid every day.
            </h2>
          </div>
          <dl className="grid grid-cols-2 gap-x-10 gap-y-4 sm:grid-cols-4">
            {STATS.map((stat) => (
              <div key={stat.label}>
                <dt className="text-xs text-muted-foreground">{stat.label}</dt>
                <dd className="mt-1 font-mono text-xl font-semibold tabular-nums text-foreground">{stat.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <div className="relative mt-10 overflow-hidden mask-[linear-gradient(to_right,transparent,#000_10%,#000_90%,transparent)]">
        <ul className="animate-marquee flex w-max gap-4" aria-label="Recent payouts">
          {[...PAYOUTS, ...PAYOUTS].map((payout, index) => (
            <PayoutCard key={`${payout.trader}-${index}`} payout={payout} />
          ))}
        </ul>
      </div>
    </section>
  )
}
