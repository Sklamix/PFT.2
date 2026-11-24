import { LegalDocument } from '@/components/legal/legal-document'

export const metadata = {
  title: 'AML / KYC Policy — Professional Funded Trader',
  description: 'Identity verification, sanctions screening and anti-money-laundering policy for PFT.',
  robots: { index: false, follow: true },
}

const UPDATED = '21 November 2026'

export default function AmlKycPage() {
  return (
    <LegalDocument
      title="AML / KYC Policy"
      updated={UPDATED}
      intro="To operate a trading evaluation platform we are required to know who our customers are, to verify that identity, and to screen for sanctioned parties and other prohibited counterparties. This policy sets out what we require, when we require it, and what happens if verification cannot be completed."
      sections={[
        {
          heading: '1. Why we verify identity',
          body: (
            <p>
              Know-your-customer and anti-money-laundering rules apply to the markets in which
              we operate and to the payment providers we rely on. Verification is also what
              allows us to enforce the restricted-jurisdiction list and to keep the platform
              available to legitimate traders.
            </p>
          ),
        },
        {
          heading: '2. When verification is required',
          body: (
            <>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <strong>Before a funded account is issued.</strong> Evaluation credentials are
                  issued only after identity and address verification has completed. This is why
                  KYC is a one-time step rather than a recurring one.
                </li>
                <li>
                  <strong>Before a payout is released.</strong> We re-check the payout recipient
                  and the payout destination against the verified profile.
                </li>
                <li>
                  <strong>On request.</strong> We may ask for refreshed documentation where a
                  document has expired, where a risk indicator is triggered, or where our
                  provider's monitoring flags a transaction.
                </li>
              </ul>
            </>
          ),
        },
        {
          heading: '3. What we require',
          body: (
            <>
              <ul className="list-disc space-y-1 pl-5">
                <li>A government-issued photo identity document.</li>
                <li>A proof of address dated within the last 90 days.</li>
                <li>
                  Your name as it appears on the identity document, and a confirmation that you
                  live at the address you provided.
                </li>
                <li>A liveness or selfie check where our provider requires one.</li>
              </ul>
              <p>
                Documents are submitted through our verification provider. Where the provider
                supports it, the document is captured on your device and transmitted directly to
                the provider, and we receive the verification result rather than the document
                image itself.
              </p>
            </>
          ),
        },
        {
          heading: '4. Sanctions and prohibited counterparties',
          body: (
            <p>
              We maintain and screen against applicable sanctions, politically-exposed-person and
              other restricted-party lists. Residents of sanctioned or otherwise restricted
              jurisdictions cannot participate in the platform, and we decline accounts and
              payouts where a screening match is identified. A screening match is never resolved
              by asking the customer to explain it away.
            </p>
          ),
        },
        {
          heading: '5. Data handling',
          body: (
            <p>
              Verification data is used for the verification itself, for regulatory record
              keeping, and for ongoing monitoring. It is not sold and is not used for marketing.
              Retention periods follow the record-keeping requirements that apply to us. The
              Privacy Policy describes how this data is processed in general.
            </p>
          ),
        },
        {
          heading: '6. Failed or refused verification',
          body: (
            <>
              <p>
                If verification cannot be completed, we will tell you why in general terms and
                what you can do about it — most often a rejected document image, an expired
                document, or a mismatch between the address on the document and the address on
                your account.
              </p>
              <p>
                Where a verification is refused and cannot be resolved, the purchase may be
                refunded in accordance with the Refund Policy, and the account is closed. Repeated
                attempts with materially false documents are treated as abuse.
              </p>
            </>
          ),
        },
        {
          heading: '7. Prohibited use of the platform',
          body: (
            <p>
              Using the platform to launder money, to trade on behalf of others without an
              agreement, to evade a trading restriction, or to attempt to manipulate the simulation
              or the payout process is prohibited. Detection of such activity may lead to
              immediate account closure, forfeiture of any pending payout, and referral to the
              relevant authorities.
            </p>
          ),
        },
        {
          heading: '8. Contact',
          body: (
            <p>
              Verification questions can be sent to support@pft.trade. Please do not send
              identity documents by email.
            </p>
          ),
        },
      ]}
    />
  )
}
