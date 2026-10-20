'use client'

import { useState } from 'react'
import { Menu, X } from 'lucide-react'
import { BrandLogo } from '@/components/brand-logo'
import { cn } from '@/lib/utils'

const NAV_LINKS = [
  { label: 'Challenges', href: '#challenges' },
  { label: 'Evaluation Rules', href: '#rules' },
  { label: 'Payout Proofs', href: '#payouts' },
  { label: 'Trading Platforms', href: '#platforms' },
  { label: 'FAQ', href: '#faq' },
]

export function SiteHeader() {
  const [open, setOpen] = useState(false)

  return (
    <>
    <header className="sticky top-0 z-50 border-b border-border/80 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-6 px-4 sm:px-6 lg:px-8">
        <BrandLogo />

        <nav aria-label="Primary" className="hidden lg:block">
          <ul className="flex items-center gap-1">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  className="rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex items-center gap-2">
          <a
            href="/auth/login"
            className="home-header-cta group inline-flex h-10 items-center gap-2 rounded-full bg-lime-300 px-5 text-sm font-bold text-[#11160b] shadow-[0_0_24px_-10px_rgba(163,230,53,0.9)] transition-colors hover:bg-lime-200"
          >
            Get Started <span className="transition-transform group-hover:translate-x-0.5" aria-hidden="true">→</span>
          </a>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls="mobile-nav"
            className="inline-flex size-9 items-center justify-center rounded-md border border-border text-foreground lg:hidden"
          >
            {open ? <X className="size-4" /> : <Menu className="size-4" />}
            <span className="sr-only">{open ? 'Close menu' : 'Open menu'}</span>
          </button>
        </div>
      </div>

      <nav
        id="mobile-nav"
        aria-label="Mobile"
        className={cn('border-t border-border bg-background lg:hidden', open ? 'block' : 'hidden')}
      >
        <ul className="mx-auto flex max-w-7xl flex-col px-4 py-3 sm:px-6">
          {NAV_LINKS.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                onClick={() => setOpen(false)}
                className="block rounded-md px-3 py-2.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </header>
    <a
      href="#challenges"
      className="home-floating-cta group fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] z-[60] inline-flex h-12 items-center gap-2 rounded-full bg-lime-300 px-5 text-sm font-bold text-[#11160b] shadow-[0_8px_28px_-8px_rgba(163,230,53,0.8)] transition-colors hover:bg-lime-200"
    >
      Get Funded <span className="transition-transform group-hover:translate-x-0.5" aria-hidden="true">→</span>
    </a>
    </>
  )
}
