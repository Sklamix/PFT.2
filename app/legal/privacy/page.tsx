import { LegalDocument } from '@/components/legal/legal-document'

export const metadata = {
  title: 'Privacy Policy — Professional Funded Trader',
  description: 'How PFT collects, uses, stores and protects personal data.',
}

const UPDATED = '21 November 2026'

export default function PrivacyPage() {
  return (
    <LegalDocument
      title="Privacy Policy"
      updated={UPDATED}
      intro="This policy explains what personal data Professional Funded Trader (PFT) collects, why we collect it, how long we keep it and what rights you have over it. It applies to the web terminal, the checkout flow, the support desk and the AI-assisted support features."
      sections={[
        {
          heading: '1. Who is responsible for your data',
          body: (
            <p>
              Professional Funded Trader Ltd is the data controller for personal data processed
              through this platform. Our privacy contact is support@pft.trade. Identity and
              verification data is handled under the AML / KYC Policy.
            </p>
          ),
        },
        {
          heading: '2. What we collect',
          body: (
            <>
              <p>We collect only what the platform needs to operate an evaluation:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <strong>Account data:</strong> email address, a password hash, and where you
                  choose to provide them, your name, phone number and country.
                </li>
                <li>
                  <strong>Verification data:</strong> the identity document and proof of address you
                  submit for KYC, together with the result of the check.
                </li>
                <li>
                  <strong>Trading data:</strong> simulated orders, positions, equity and the
                  performance metrics derived from them, and the audit trail of actions taken in
                  the admin console.
                </li>
                <li>
                  <strong>Payment data:</strong> the order reference, amount, currency and payment
                  status returned by our payment provider. We do not store full card numbers.
                </li>
                <li>
                  <strong>Technical data:</strong> IP address, device and browser information,
                  session and rate-limiting records, and application logs used for security and
                  reliability.
                </li>
                <li>
                  <strong>Support data:</strong> the content of your support conversations and any
                  documents you attach.
                </li>
              </ul>
            </>
          ),
        },
        {
          heading: '3. Why we use it',
          body: (
            <>
              <ul className="list-disc space-y-1 pl-5">
                <li>To operate your account, run the simulation and compute your metrics.</li>
                <li>To verify identity and satisfy our AML / KYC obligations.</li>
                <li>To process payments and administer refunds.</li>
                <li>To review payouts and investigate suspected rule breaches.</li>
                <li>To secure the platform — rate limiting, fraud detection and abuse prevention.</li>
                <li>To answer your support requests, including through the AI assistant.</li>
                <li>To meet legal, tax and accounting record-keeping requirements.</li>
              </ul>
              <p>
                We do not sell personal data, and we do not share it for advertising. We share it
                only with processors who act on our instructions: our payment provider, our KYC
                provider, our email delivery provider, our hosting and AI infrastructure providers,
                and our AI model provider for support conversations.
              </p>
            </>
          ),
        },
        {
          heading: '4. AI-assisted support and your conversations',
          body: (
            <>
              <p>
                When you use the support assistant, the relevant parts of your conversation are sent
                to our AI infrastructure and to the underlying model provider so that an answer can
                be produced. The same request key and request hash are stored so that a repeated
                identical question returns the stored answer instead of being sent again.
              </p>
              <p>
                Do not submit information you are not comfortable sharing with a model provider —
                in particular, do not submit identity documents through the assistant. Use the
                secure verification flow for those.
              </p>
            </>
          ),
        },
        {
          heading: '5. Cookies and local storage',
          body: (
            <p>
              We use strictly necessary cookies to keep you signed in and to protect admin and
              API routes. These cannot be switched off without breaking the platform. We do not
              use advertising cookies or cross-site tracking cookies.
            </p>
          ),
        },
        {
          heading: '6. Retention',
          body: (
            <p>
              We keep account and trading data for as long as your account is open, and afterwards
              for the period required by our record-keeping and dispute-resolution obligations.
              Payment records are retained as required by tax law. Verification documents are
              retained for the period required by AML regulation. Technical security logs are
              retained for a limited period and then deleted or anonymised.
            </p>
          ),
        },
        {
          heading: '7. Your rights',
          body: (
            <>
              <p>
                Depending on where you live, you may have the right to access, correct, delete or
                port your personal data, to object to or restrict certain processing, and to
                withdraw consent where processing relies on consent. You can exercise most of
                these rights directly from your profile settings.
              </p>
              <p>
                To make a request that we cannot fulfil from the interface, contact
                support@pft.trade. We will verify your identity before acting on the request. You
                also have the right to complain to your local data protection authority.
              </p>
            </>
          ),
        },
        {
          heading: '8. Security',
          body: (
            <p>
              Passwords are stored as salted scrypt hashes, never in plaintext. Data in transit is
              protected with TLS. Access to the admin console is restricted to verified staff
              accounts and privileged actions require a second approver. No system is perfectly
              secure, and we will notify you and the relevant authority if a breach affects your
              data.
            </p>
          ),
        },
        {
          heading: '9. Children',
          body: (
            <p>
              The platform is not directed at anyone under 18 and we do not knowingly collect
              data from children. If you believe a child has provided us with data, contact us and
              we will delete it.
            </p>
          ),
        },
        {
          heading: '10. Changes',
          body: (
            <p>
              We update this policy when our processing changes. The revision date is shown at the
              top of this page, and material changes are announced on the platform.
            </p>
          ),
        },
      ]}
    />
  )
}
