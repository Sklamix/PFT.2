import { LegalDocument } from '@/components/legal/legal-document'

export const metadata = {
  title: 'Terms of Service — Professional Funded Trader',
  description: 'Terms governing access to the PFT simulated trading evaluation platform.',
}

const UPDATED = '21 November 2026'

export default function TermsPage() {
  return (
    <LegalDocument
      title="Terms of Service"
      updated={UPDATED}
      intro="These terms govern your access to the Professional Funded Trader (PFT) platform, including the web terminal, the evaluation products offered through it, and any related support or AI-assisted features. By creating an account or purchasing an evaluation you accept these terms."
      sections={[
        {
          heading: '1. What PFT is — and is not',
          body: (
            <>
              <p>
                PFT provides simulated trading evaluations. Every account, every position and every
                performance figure on the platform is simulated. No real capital is allocated, no
                real positions are opened in a market, and no real money is at risk in the
                evaluation itself.
              </p>
              <p>
                PFT is not a broker. PFT does not accept deposits, does not provide custody,
                brokerage, investment advice or asset management, and does not guarantee any level
                of profit, income or outcome. Past simulated performance is not indicative of
                future results.
              </p>
            </>
          ),
        },
        {
          heading: '2. Eligibility',
          body: (
            <>
              <p>
                You must be at least 18 years old, legally able to enter into this contract, and
                resident in a jurisdiction where the service is lawfully available. The list of
                restricted and sanctioned jurisdictions is maintained with our AML / KYC Policy and
                with the eligibility check applied during signup.
              </p>
              <p>
                One person may hold a maximum number of accounts and a maximum total simulated
                allocation as described in the Evaluation Rules. Registering multiple accounts to
                work around a limit, or sharing an account with anyone else, is prohibited.
              </p>
            </>
          ),
        },
        {
          heading: '3. Evaluation purchases',
          body: (
            <>
              <p>
                Evaluation fees are charged once, at purchase, and are non-refundable. Optional
                add-ons such as a backup account or an account reset are also non-refundable. A
                purchase is completed when payment is confirmed and the evaluation is issued to
                your account.
              </p>
              <p>
                Where a purchase cannot be fulfilled because of a technical failure on our side,
                we will either repair the purchase or refund it in full. Refunds are governed by
                the Refund Policy.
              </p>
            </>
          ),
        },
        {
          heading: '4. Evaluation rules and conduct',
          body: (
            <>
              <p>
                Each evaluation is governed by the Evaluation Rules, which are shown in full
                before purchase and are also available on this website. The rules cover profit
                targets, daily loss, overall drawdown, minimum trading days, inactivity, permitted
                instruments, leverage, prohibited practices, account limits and the payout
                process.
              </p>
              <p>
                Prohibited practices include hedging across accounts, arbitrage and latency
                exploitation, tick scalping, martingale and grid systems, account sharing, and
                reliance on price-feed errors in the simulated environment. Breach of these rules
                may result in closure of the account without payout, and repeated abuse may lead
                to permanent exclusion.
              </p>
            </>
          ),
        },
        {
          heading: '5. Payouts',
          body: (
            <>
              <p>
                A funded account may request a payout once it has satisfied the payout conditions,
                including the profit split, the minimum trading days and the absence of any open
                investigation. Payout requests are reviewed by a human operator. The evaluation
                fee is not returned with the first payout.
              </p>
              <p>
                We may withhold or decline a payout where a breach, a rule violation, an
                unresolved account limitation, or a KYC/AML concern exists. Where a payout is
                declined for a reason that is not a rule breach, we will tell you which rule
                applies.
              </p>
            </>
          ),
        },
        {
          heading: '6. AI-assisted features',
          body: (
            <>
              <p>
                The support assistant is an AI feature. It can make mistakes, it is not a source of
                authoritative information, and it must never be treated as financial, legal or tax
                advice. Where the assistant and the Evaluation Rules disagree, the Evaluation
                Rules govern.
              </p>
            </>
          ),
        },
        {
          heading: '7. Intellectual property and acceptable use',
          body: (
            <>
              <p>
                The platform, its software, its design, its data and its brand are owned by PFT. You
                may not copy, resell, scrape, reverse engineer, automate bulk access to, or attempt
                to interfere with the platform or its infrastructure. We may suspend access
                immediately where use poses a security, legal or operational risk.
              </p>
            </>
          ),
        },
        {
          heading: '8. Limitation of liability',
          body: (
            <>
              <p>
                To the maximum extent permitted by law, PFT is not liable for indirect or
                consequential loss, for loss of profit, for loss of data, or for the unavailability
                of the platform. PFT's total aggregate liability arising out of or in connection
                with an evaluation is limited to the amount you paid for that evaluation.
              </p>
              <p>
                Nothing in these terms excludes liability that cannot lawfully be excluded, and
                nothing in these terms limits your statutory rights as a consumer.
              </p>
            </>
          ),
        },
        {
          heading: '9. Changes to these terms',
          body: (
            <>
              <p>
                We may amend these terms. Material changes are announced on the platform and, where
                required, notified by email before they take effect. Changes apply from the date
                stated and do not affect evaluations already purchased, except where a change is
                required by law or by a regulatory change that applies to funded accounts.
              </p>
            </>
          ),
        },
        {
          heading: '10. Governing law and contact',
          body: (
            <>
              <p>
                These terms are governed by the laws of the jurisdiction in which PFT Ltd is
                incorporated. Questions about these terms can be sent to support@pft.trade.
              </p>
            </>
          ),
        },
      ]}
    />
  )
}
