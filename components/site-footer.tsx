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
      { label: 'Why PFT', href: '#payouts' },
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
    <footer data-home-reveal className="relative overflow-hidden border-t border-white/5 bg-[#02040a]">
      <span className="pointer-events-none absolute inset-x-[12%] top-0 h-px bg-linear-to-r from-transparent via-primary/60 to-transparent" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_100%,rgba(37,99,235,0.16),transparent_55%)]" />
      <div className="pointer-events-none absolute -bottom-40 left-1/2 size-[42rem] -translate-x-1/2 rounded-full border border-primary/10" />
      <div className="pointer-events-none absolute inset-0 cosmic-stars opacity-40" />

      <div className="relative mx-auto max-w-7xl px-4 pt-16 pb-10 sm:px-6 lg:px-8 2xl:max-w-[1600px]">
        <div className="grid gap-12 lg:grid-cols-[1.2fr_2fr]">
          <div className="flex flex-col gap-5">
            <BrandLogo />
            <p className="max-w-sm text-sm leading-relaxed text-slate-400">
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
                    className="inline-flex h-8 items-center rounded-full border border-white/10 bg-white/[0.025] px-3 text-xs text-slate-400 transition-colors hover:border-primary/40 hover:text-white"
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
                <h3 className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">{column.title}</h3>
                <ul className="mt-4 flex flex-col gap-2.5">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <a href={link.href} className="text-sm text-slate-400 transition-colors hover:text-white">
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        <div id="disclaimer" className="mt-14 rounded-2xl border border-white/10 bg-white/[0.025] p-5 backdrop-blur-md">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-300">Risk disclaimer</h3>
          <div className="mt-3 flex flex-col gap-3 text-xs leading-relaxed text-slate-500">
            <p>
              All accounts provided by Professional Funded Trader are demo accounts with simulated funds, and all trading
              activity takes place in a simulated environment. PFT is not a broker, does not accept deposits, and does not
              provide investment advice, custody, or brokerage services. Payouts are performance rewards based on simulated
              trading results and are funded by the company.
            </p>
            <p>
              Trading leveraged products such as Forex, CFDs, indices and cryptocurrencies involves substantial risk and may
              not be suitable for all individuals. Past simulated performance is not indicative of future results. Services
              are not available in jurisdictions where they would be contrary to local law or regulation.
            </p>
          </div>
        </div>

        <div className="mt-10 flex flex-col gap-3 border-t border-white/[0.06] pt-6 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <p>&copy; 2026 Professional Funded Trader Ltd. All rights reserved.</p>
          <p className="flex items-center gap-2 font-mono">
            <span className="size-1.5 rounded-full bg-highlight shadow-[0_0_8px_2px_rgba(6,182,212,0.45)]" />
            All systems operational
          </p>
        </div>
      </div>
    </footer>
  )
}
