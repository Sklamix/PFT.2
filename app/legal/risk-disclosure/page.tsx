import { LegalDocument } from '@/components/legal/legal-document'

export const metadata = {
  title: 'Risk Disclosure — Professional Funded Trader',
  description: 'Risk disclosure for PFT simulated trading evaluations.',
}

const UPDATED = '21 November 2026'

export default function RiskDisclosurePage() {
  return (
    <LegalDocument
      title="Risk Disclosure"
      updated={UPDATED}
      intro="Read this document carefully before purchasing an evaluation. It describes the nature of the service, the risks involved in trading generally, and the specific limitations of a simulated evaluation."
      sections={[
        {
          heading: '1. The simulation is not the market',
          body: (
            <>
              <p>
                PFT evaluations run in a simulated environment. Prices, spreads, liquidity,
                slippage, swap and news behaviour in the simulation are approximations. They will
                not match what you would have experienced in a live market, and they can differ
                from the live market in ways that are material to your decisions. The simulation
                is designed to evaluate rule compliance and trading behaviour, not to reproduce
                live execution quality.
              </p>
              <p>
                A successful evaluation therefore does not establish that the same results would
                have been achieved with real capital, and a failed evaluation does not establish
                that real trading would have succeeded.
              </p>
            </>
          ),
        },
        {
          heading: '2. Trading leveraged products involves substantial risk',
          body: (
            <p>
              Leveraged trading of forex, CFDs, indices, commodities and cryptocurrencies exposes
              you to the risk of losing more than you anticipate, and in some cases to losses
              exceeding the margin you have allocated. Losses may arise rapidly and may exceed the
              amount you are prepared to lose. Past simulated performance is not indicative of
              future results.
            </p>
          ),
        },
        {
          heading: '3. PFT is not a broker and does not provide advice',
          body: (
            <p>
              PFT is not a broker, does not accept deposits, does not hold client funds, and does
              not provide investment, legal or tax advice. Payouts are performance rewards for
              simulated trading, funded by the company, and are not returns on invested capital,
              interest, or a managed portfolio.
            </p>
          ),
        },
        {
          heading: '4. Payouts are discretionary and reviewed',
          body: (
            <p>
              Payout requests are reviewed by an operator and are granted at our discretion where
              the payout conditions are met. We may withhold a payout while a breach, an abuse
              investigation, or a KYC/AML review is open. A payout is not a guaranteed entitlement
              that arises automatically from meeting a profit target.
            </p>
          ),
        },
        {
          heading: '5. Evaluation-specific risks',
          body: (
            <>
              <p>
                Evaluations impose a daily loss limit, an overall drawdown limit, a minimum number
                of trading days, and rules on permitted instruments, prohibited practices and
                inactivity. These limits are strict and are measured continuously. A rule breach
                closes the account and ends the evaluation.
              </p>
              <p>
                Where you purchase a reset or a backup account, the new account starts from the
                beginning of the evaluation phases; it is not a restoration of the previous state.
                Reset availability is limited, may be unavailable for frozen backup accounts or
                abuse-related breaches, and is rate-limited.
              </p>
            </>
          ),
        },
        {
          heading: '6. Market and technology risk',
          body: (
            <p>
              Our platform depends on third-party infrastructure — market data, hosting,
              payments, identity verification and AI providers. These may be unavailable,
              delayed, or inaccurate. We may suspend trading, pause withdrawals, or restrict
              features where necessary to protect the platform or its users. We do not guarantee
              continuous availability of any feature.
            </p>
          ),
        },
        {
          heading: '7. Your responsibility to check before trading',
          body: (
            <p>
              It is your responsibility to read the Evaluation Rules, to confirm that a product is
              available in your jurisdiction, and to ensure that your trading behaviour complies
              with those rules. If you are unsure whether a strategy or instrument is permitted,
              contact support before trading.
            </p>
          ),
        },
      ]}
    />
  )
}
