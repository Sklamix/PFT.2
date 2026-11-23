'use client'

import { useEffect, useRef, type KeyboardEvent } from 'react'
import { ArrowRight, X } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import type { PlanetSpot } from './planet-spots'

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function PlanetAdvantageCard({
  spot,
  onClose,
  onNavigate,
}: {
  spot: PlanetSpot
  onClose: () => void
  onNavigate: (href: PlanetSpot['href']) => void
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [spot.id])

  const trapFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !cardRef.current) return
    const focusable = [...cardRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]

    if (event.shiftKey && (document.activeElement === first || document.activeElement === titleRef.current)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <Card
      ref={cardRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`planet-advantage-${spot.id}`}
      className="relative w-full max-w-[520px] gap-0 overflow-hidden rounded-2xl border border-white/10 bg-card/90 py-0 shadow-[0_28px_90px_-35px_rgb(0_0_0/0.95)] ring-0 backdrop-blur-xl"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={trapFocus}
    >
      <span className="pointer-events-none absolute inset-x-[16%] top-0 h-px bg-linear-to-r from-transparent via-primary/80 to-transparent" />
      <CardHeader className="gap-4 px-7 pt-8 pb-4 pr-16">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">{spot.label}</p>
        <CardTitle
          ref={titleRef}
          id={`planet-advantage-${spot.id}`}
          tabIndex={-1}
          className="text-balance text-2xl leading-tight font-semibold tracking-[-0.02em] text-foreground outline-none sm:text-3xl"
        >
          {spot.heading}
        </CardTitle>
      </CardHeader>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Close advantage"
        onClick={onClose}
        className="absolute top-4 right-4 rounded-full text-muted-foreground hover:bg-white/10 hover:text-foreground"
      >
        <X className="size-4" />
      </Button>
      <CardContent className="px-7 pb-8">
        <p className="max-w-[62ch] text-base leading-7 text-foreground/80">{spot.body}</p>
        <a
          href={spot.href}
          onClick={(event) => {
            event.preventDefault()
            onNavigate(spot.href)
          }}
          className="group mt-6 inline-flex items-center gap-2 rounded-lg text-sm font-semibold text-primary underline-offset-4 outline-none transition-colors hover:text-highlight focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-4 focus-visible:ring-offset-background"
        >
          {spot.ctaLabel}
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-1 motion-reduce:transition-none" />
        </a>
      </CardContent>
    </Card>
  )
}
