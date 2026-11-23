'use client'

import { useEffect } from 'react'

import { PlanetAdvantageCard } from './planet-advantage-card'
import type { PlanetSpot } from './planet-spots'

/**
 * Mobile presentation of an advantage. A bottom sheet keeps the planet visible
 * above it and never reflows the hero, which is what the inline card used to do.
 */
export function PlanetAdvantageSheet({
  spot,
  onClose,
  onNavigate,
}: {
  spot: PlanetSpot
  onClose: () => void
  onNavigate: (href: PlanetSpot['href']) => void
}) {
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  return (
    <div className="fixed inset-0 z-[70] lg:hidden">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-background/70 backdrop-blur-sm motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300"
        onPointerDown={onClose}
      />
      <div className="absolute inset-x-0 bottom-0 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] motion-safe:animate-in motion-safe:slide-in-from-bottom-4 motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]">
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-white/20" aria-hidden="true" />
        <PlanetAdvantageCard spot={spot} compact onClose={onClose} onNavigate={onNavigate} />
      </div>
    </div>
  )
}
