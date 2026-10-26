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
    <header className="sticky top-0 z-50 border-b border-white/5 bg-[#02040a]/55 backdrop-blur-2xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-6 px-4 sm:px-6 lg:px-8">
        <BrandLogo />

        <nav aria-label="Primary" className="hidden lg:block">
          <ul className="flex items-center gap-1">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  className="rounded-full px-3 py-2 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500 transition-colors hover:bg-white/5 hover:text-white"
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
            className="home-header-cta group inline-flex h-10 items-center gap-2 rounded-full border border-primary/40 bg-primary/15 px-5 text-[11px] font-bold uppercase tracking-[0.16em] text-white shadow-[0_0_28px_-12px_rgba(59,130,246,0.9)] backdrop-blur-md transition-colors hover:bg-primary/25"
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
                className="block rounded-lg px-3 py-2.5 text-sm text-slate-400 hover:bg-white/5 hover:text-white"
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
      className="home-floating-cta group fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] z-[60] inline-flex h-12 items-center gap-2 rounded-full border border-primary/40 bg-[#07101c]/90 px-5 text-[11px] font-bold uppercase tracking-[0.16em] text-white shadow-[0_8px_32px_-10px_rgba(59,130,246,0.9)] backdrop-blur-xl transition-colors hover:border-primary hover:bg-primary/15"
    >
      Get Funded <span className="transition-transform group-hover:translate-x-0.5" aria-hidden="true">→</span>
    </a>
    </>
  )
}
