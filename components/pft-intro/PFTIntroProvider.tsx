'use client'

import dynamic from 'next/dynamic'
import { useEffect, useRef, useState } from 'react'

const PFTLoadingScreen = dynamic(() => import('./PFTLoadingScreen').then((mod) => mod.PFTLoadingScreen), {
  ssr: false,
})

type IntroState = 'playing' | 'exiting' | 'done'

const INTRO_MS = 2050
const EXIT_MS = 700
const HARD_TIMEOUT_MS = 4500

/**
 * Shows the brand intro once per browser session, on the initial page load.
 * It never replays on in-app navigation because the provider lives in the root
 * layout, which does not remount across client-side route changes.
 */
export function PFTIntroProvider({ children }: { children: React.ReactNode }) {
  // Decide synchronously on first client render (the overlay is a client-only
  // dynamic import, so this never causes an SSR/hydration mismatch). Reduced
  // motion and repeat visits skip the intro without even a one-frame flash.
  const [state, setState] = useState<IntroState>(() => {
    if (typeof window === 'undefined') return 'playing'
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'done'
    if (sessionStorage.getItem('pft:intro:shown') === '1') return 'done'
    return 'playing'
  })
  const [reduced, setReduced] = useState(false)
  const timers = useRef<number[]>([])

  useEffect(() => {
    if (state !== 'playing') return
    sessionStorage.setItem('pft:intro:shown', '1')

    document.documentElement.style.overflow = 'hidden'
    timers.current.push(
      window.setTimeout(() => setState('exiting'), INTRO_MS),
      window.setTimeout(() => {
        document.documentElement.style.overflow = ''
        setState('done')
      }, INTRO_MS + EXIT_MS),
      // Graceful fallback so the intro can never trap the user.
      window.setTimeout(() => {
        document.documentElement.style.overflow = ''
        setState('done')
      }, HARD_TIMEOUT_MS),
    )
  }, [state])

  useEffect(() => {
    return () => {
      timers.current.forEach((id) => window.clearTimeout(id))
      document.documentElement.style.overflow = ''
    }
  }, [])

  return (
    <>
      {state === 'playing' || state === 'exiting' ? (
        <PFTLoadingScreen exiting={state === 'exiting'} reduced={reduced} />
      ) : null}
      {children}
    </>
  )
}
