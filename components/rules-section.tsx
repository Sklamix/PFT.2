import { Gauge, Scale, Globe, Ban } from 'lucide-react'
import { DrawdownExplainer } from '@/components/drawdown-explainer'
import { SectionHeading } from '@/components/section-heading'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'

const RULES = [
  {
    value: 'drawdown',
    icon: Gauge,
    title: 'Drawdown calculations',
    content: [
      'Daily drawdown resets at 00:00 server time and is measured from the higher of your balance or equity at that moment. Floating losses count toward the limit.',
      'Overall drawdown is either static (fixed below your initial balance) or trailing (follows your equity high-water mark until it locks at the starting balance).',
    ],
  },
  {
    value: 'consistency',
    icon: Scale,
    title: 'Consistency rule',
    content: [
      'On funded accounts, no single trading day may account for more than 40% of total profit in a payout cycle. This only affects payout eligibility — it never breaches your account.',
      'If one day exceeds the threshold, simply keep trading until your overall profit rebalances the ratio.',
    ],
  },
  {
    value: 'ip',
    icon: Globe,
    title: 'IP address & device guidelines',
    content: [
      'Each account must be traded by the registered trader only. VPNs and VPS servers are permitted, but your login region should remain consistent with your KYC country.',
      'Account sharing, copy trading between unrelated traders, or simultaneous logins from multiple countries will trigger a manual compliance review.',
    ],
  },
  {
    value: 'prohibited',
    icon: Ban,
    title: 'Prohibited strategies',
    content: [
      'Latency arbitrage, tick scalping exploits, opposite-account hedging, and any strategy that relies on simulated-environment price feed errors are not permitted.',
    ],
  },
]

export function RulesSection() {
  return (
    <section
      id="rules"
      aria-labelledby="rules-heading"
      data-home-reveal
      className="relative overflow-hidden border-b border-white/5 py-24 sm:py-32"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_20%_0%,rgba(59,130,246,0.14),transparent_48%)]" />
      <div className="pointer-events-none absolute -left-52 top-28 size-[32rem] rounded-full border border-primary/10" />
      <div className="pointer-events-none absolute inset-0 cosmic-stars opacity-50" />

      <div className="relative mx-auto grid max-w-7xl gap-12 px-4 sm:px-6 lg:grid-cols-2 lg:gap-16 lg:px-8 2xl:max-w-[1600px]">
        <div className="flex flex-col gap-10">
          <SectionHeading
            id="rules-heading"
            eyebrow="Rules & risk clarity"
            title="No hidden rules. No fine print."
            description="Every limit is calculated transparently and visible in real time inside your trader portal."
            align="left"
          />
          <Accordion
            defaultValue={['drawdown']}
            className="cosmic-card rounded-[1.75rem] px-5"
          >
            {RULES.map(({ value, icon: Icon, title, content }) => (
              <AccordionItem key={value} value={value} className="border-white/[0.07]">
                <AccordionTrigger className="py-5 text-base text-slate-200 hover:no-underline">
                  <span className="flex items-center gap-3">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10">
                      <Icon className="size-3.5 text-primary" aria-hidden="true" />
                    </span>
                    {title}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="pb-5 pl-11 leading-relaxed text-slate-400">
                  {content.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
        <div className="lg:pt-24">
          <DrawdownExplainer />
        </div>
      </div>
    </section>
  )
}
