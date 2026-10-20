import { BrandLogo } from '@/components/brand-logo'

const COLUMNS = [
  {
    title: 'Programs',
    links: [
      { label: '1-Step Challenge', href: '#challenges' },
      { label: '2-Step Evaluation', href: '#challenges' },
      { label: 'Scaling Plan', href: '#challenges' },
      { label: 'Trading Platforms', href: '#platforms' },
    ],
  },
  {
    title: 'Resources',
    links: [
      { label: 'Evaluation Rules', href: '#rules' },
      { label: 'Payout Proofs', href: '#payouts' },
      { label: 'Trader Portal', href: '#dashboard' },
      { label: 'FAQ', href: '#faq' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'About', href: '#top' },
      { label: 'Affiliates', href: '#top' },
      { label: 'Careers', href: '#top' },
      { label: 'Contact', href: 'mailto:support@pft.trade' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Terms of Service', href: '#top' },
      { label: 'Privacy Policy', href: '#top' },
      { label: 'Risk Disclosure', href: '#disclaimer' },
      { label: 'AML / KYC Policy', href: '#top' },
    ],
  },
]

const SOCIALS = [
  { label: 'X', href: 'https://x.com' },
  { label: 'Discord', href: 'https://discord.com' },
  { label: 'YouTube', href: 'https://youtube.com' },
  { label: 'Instagram', href: 'https://instagram.com' },
  { label: 'Telegram', href: 'https://telegram.org' },
]

export function SiteFooter() {
  return (
    <footer data-home-reveal className="bg-background">
      <div className="mx-auto max-w-7xl px-4 pt-16 pb-10 sm:px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-[1.2fr_2fr]">
          <div className="flex flex-col gap-5">
            <BrandLogo />
            <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
              Professional Funded Trader provides simulated trading evaluations and performance-based rewards for skilled
              traders worldwide.
            </p>
            <ul className="flex flex-wrap gap-2" aria-label="Social links">
              {SOCIALS.map((social) => (
                <li key={social.label}>
                  <a
                    href={social.href}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                  >
                    {social.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <nav aria-label="Footer" className="grid grid-cols-2 gap-8 sm:grid-cols-4">
            {COLUMNS.map((column) => (
              <div key={column.title}>
                <h3 className="text-sm font-semibold text-foreground">{column.title}</h3>
                <ul className="mt-4 flex flex-col gap-2.5">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <a href={link.href} className="text-sm text-muted-foreground transition-colors hover:text-foreground">
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        <div id="disclaimer" className="mt-14 rounded-xl border border-border bg-card p-5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">Risk disclaimer</h3>
          <div className="mt-3 flex flex-col gap-3 text-xs leading-relaxed text-muted-foreground">
            <p>
              All accounts provided by Professional Funded Trader are demo accounts with simulated funds, and all trading
              activity takes place in a simulated environment. PFT is not a broker, does not accept deposits, and does not
              provide investment advice, custody, or brokerage services. Payouts are performance rewards based on simulated
              trading results and are funded by the company.
            </p>
            <p>
              Trading leveraged products such as Forex, CFDs, indices and cryptocurrencies involves substantial risk and may
              not be suitable for all individuals. Past simulated performance is not indicative of future results.
              Testimonials and payout figures shown may not be representative of other traders. Services are not available
              in jurisdictions where they would be contrary to local law or regulation.
            </p>
          </div>
        </div>

        <div className="mt-10 flex flex-col gap-3 border-t border-border pt-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>&copy; 2026 Professional Funded Trader Ltd. All rights reserved.</p>
          <p className="font-mono">All systems operational</p>
        </div>
      </div>
    </footer>
  )
}
