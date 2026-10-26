import { SectionHeading } from '@/components/section-heading'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'

const FAQS = [
  {
    question: 'When can I request my first payout?',
    answer:
      'Your first payout can be requested 14 days after placing your first trade on a funded account. After that, payouts are bi-weekly, or on-demand once your account is up 5%. Requests are processed in 8 hours on average.',
  },
  {
    question: 'Is the challenge fee really refundable?',
    answer:
      'Yes. Your full evaluation fee is reimbursed together with your first successful payout on the funded account.',
  },
  {
    question: 'What happens if I breach a drawdown limit?',
    answer:
      'The account is closed and you receive an email with the breach details. You can purchase a reset at a 20% discount within 7 days, which restores the account to its original size and phase.',
  },
  {
    question: 'Does the daily drawdown reset every day?',
    answer:
      'Yes. Daily drawdown resets at 00:00 server time (CE(S)T), recalculated from the higher of your balance or equity at that moment.',
  },
  {
    question: 'When is KYC required?',
    answer:
      'KYC is only required once you pass the evaluation and before your funded account credentials are issued. You will need a government-issued ID and a proof of address dated within the last 90 days.',
  },
  {
    question: 'Which countries are restricted?',
    answer:
      'We serve traders in 170+ countries. Residents of sanctioned jurisdictions cannot participate. The full list is available in our Terms of Service.',
  },
]

export function FaqSection() {
  return (
    <section
      id="faq"
      aria-labelledby="faq-heading"
      data-home-reveal
      className="relative overflow-hidden border-b border-white/5 py-24 sm:py-32"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_15%_10%,rgba(37,99,235,0.14),transparent_50%)]" />
      <div className="pointer-events-none absolute -left-40 bottom-0 size-[30rem] rounded-full bg-highlight/10 blur-[120px]" />
      <div className="pointer-events-none absolute inset-0 cosmic-stars opacity-50" />

      <div className="relative mx-auto grid max-w-7xl gap-12 px-4 sm:px-6 lg:grid-cols-[1fr_1.5fr] lg:px-8 2xl:max-w-[1600px]">
        <div>
          <SectionHeading
            id="faq-heading"
            eyebrow="FAQ"
            title="Questions, answered."
            description="Can't find what you need? Our support desk responds in under 5 minutes, 24/7."
            align="left"
          />
          <a
            href="mailto:support@pft.trade"
            className="home-button mt-6 inline-flex h-11 items-center rounded-full border border-white/15 bg-white/[0.035] px-5 text-sm font-medium text-white backdrop-blur-md transition-colors hover:border-primary/50 hover:bg-primary/10"
          >
            Contact support
          </a>
        </div>
        <Accordion className="cosmic-card rounded-[1.75rem] px-5">
          {FAQS.map((faq) => (
            <AccordionItem key={faq.question} value={faq.question} className="border-white/[0.07]">
              <AccordionTrigger className="py-5 text-base text-slate-200 hover:text-white hover:no-underline">
                {faq.question}
              </AccordionTrigger>
              <AccordionContent className="pb-5 leading-relaxed text-slate-400">
                <p>{faq.answer}</p>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  )
}
