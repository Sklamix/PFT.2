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
    <section id="rules" aria-labelledby="rules-heading" className="border-b border-border py-20 sm:py-28">
      <div className="mx-auto grid max-w-7xl gap-12 px-4 sm:px-6 lg:grid-cols-2 lg:gap-16 lg:px-8">
        <div className="flex flex-col gap-10">
          <SectionHeading
            id="rules-heading"
            eyebrow="Rules & risk clarity"
            title="No hidden rules. No fine print."
            description="Every limit is calculated transparently and visible in real time inside your trader portal."
            align="left"
          />
          <Accordion defaultValue={['drawdown']} className="rounded-2xl border border-border bg-card px-5">
            {RULES.map(({ value, icon: Icon, title, content }) => (
              <AccordionItem key={value} value={value}>
                <AccordionTrigger className="py-5 text-base hover:no-underline">
                  <span className="flex items-center gap-3">
                    <Icon className="size-4 text-primary" aria-hidden="true" />
                    {title}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="pb-5 pl-7 leading-relaxed text-muted-foreground">
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
