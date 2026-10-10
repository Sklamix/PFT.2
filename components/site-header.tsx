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
            href="#dashboard"
            className="hidden h-9 items-center rounded-md border border-border px-4 text-sm font-medium text-foreground transition-colors hover:border-muted-foreground/40 hover:bg-accent sm:inline-flex"
          >
            Client Portal
          </a>
          <a
            href="#challenges"
            className="inline-flex h-9 items-center rounded-md bg-linear-to-r from-primary to-highlight px-4 text-sm font-semibold text-primary-foreground shadow-[0_0_24px_-6px] shadow-primary/60 transition-opacity hover:opacity-90"
          >
            Get Funded
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
          <li className="sm:hidden">
            <a
              href="#dashboard"
              onClick={() => setOpen(false)}
              className="mt-2 block rounded-md border border-border px-3 py-2.5 text-center text-sm font-medium text-foreground"
            >
              Client Portal
            </a>
          </li>
        </ul>
      </nav>
    </header>
  )
}
