import { LegalDocument } from '@/components/legal/legal-document'

export const metadata = {
  title: 'Refund Policy — Professional Funded Trader',
  description: 'When an evaluation fee can be refunded by Professional Funded Trader.',
  robots: { index: false, follow: true },
}

const UPDATED = '21 November 2026'

export default function RefundPolicyPage() {
  return (
    <LegalDocument
      title="Refund Policy"
      updated={UPDATED}
      intro="This policy explains when a fee paid for an evaluation can be returned. It is written to be read alongside the Terms of Service and the Evaluation Rules."
      sections={[
        {
          heading: '1. The general rule',
          body: (
            <>
              <p>
                The evaluation fee is a one-time purchase of access to a simulated evaluation. It
                is non-refundable. This applies to the evaluation itself and to every optional
                add-on: backup accounts, account resets, and any other paid feature.
              </p>
              <p>
                The reason is straightforward. An evaluation is consumed the moment it is issued —
                the rules you are accountable to are met or missed in real time, and an evaluation
                cannot be un-run. A refund would return a product that has already been used.
              </p>
            </>
          ),
        },
        {
          heading: '2. When we do refund',
          body: (
            <>
              <p>We refund in the following circumstances:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <strong>Technical failure in the purchase.</strong> If payment is taken but the
                  evaluation is not issued to your account, or is issued incorrectly, we repair the
                  purchase; where we cannot repair it, we refund in full.
                </li>
                <li>
                  <strong>Evaluation not started.</strong> Where you have not opened or traded an
                  evaluation and you request a refund shortly after purchase, we will consider it.
                </li>
                <li>
                  <strong>Platform failure.</strong> Where a technical failure on our side prevents
                  you from completing an evaluation you are paying for, including an unrecoverable
                  failure of the trading environment.
                </li>
                <li>
                  <strong>Duplicate purchase.</strong> Where the same evaluation was charged twice.
                </li>
                <li>
                  <strong>Inability to serve your jurisdiction.</strong> If we determine after
                  purchase that we cannot lawfully serve you, we refund the evaluation fee.
                </li>
              </ul>
            </>
          ),
        },
        {
          heading: '3. When we do not refund',
          body: (
            <>
              <ul className="list-disc space-y-1 pl-5">
                <li>Rule breaches, including trading-conduct breaches.</li>
                <li>Abuse, fraud, or attempts to manipulate the simulation or the payout process.</li>
                <li>Requests made after the evaluation has been used — for example after trading has started.</li>
                <li>Change of mind about the product after the evaluation has been issued.</li>
                <li>Buyback requests on a closed account.</li>
              </ul>
              <p>
                Where an account is closed for a rule breach, no fee is returned. A purchased reset
                or backup account that is never activated because the original account was closed
                for abuse is likewise non-refundable.
              </p>
            </>
          ),
        },
        {
          heading: '4. The first payout',
          body: (
            <p>
              The evaluation fee is not returned with your first payout, and it is not deducted
              from it either. The first payout is calculated on the profit share of your
              simulated performance only.
            </p>
          ),
        },
        {
          heading: '5. How to request a refund',
          body: (
            <>
              <p>
                Send a request to support@pft.trade from the email address registered to the
                account, stating the order reference and the reason. We aim to respond within
                five business days.
              </p>
              <p>
                Approved refunds are returned to the original payment method. Depending on your
                payment provider and your bank, the funds may take several business days to
                appear. Where a card refund is required, we will confirm the amount and the card
                before issuing it.
              </p>
            </>
          ),
        },
        {
          heading: '6. Chargebacks',
          body: (
            <p>
              Filing a chargeback for an evaluation that has been used and where the fee is
              non-refundable can result in the account being closed and in a suspension from the
              platform. If you believe a refund was wrongly denied, contact us first — we would
              rather resolve it directly.
            </p>
          ),
        },
      ]}
    />
  )
}
