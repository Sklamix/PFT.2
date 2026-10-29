'use client'

import { useEffect, useRef, useState } from 'react'
import { PFTLoadingScreen } from './PFTLoadingScreen'

type IntroState = 'playing' | 'exiting' | 'done'

const INTRO_MS = 2050
const EXIT_MS = 700
const HARD_TIMEOUT_MS = 4500
const COOKIE_NAME = 'pft_intro'

function markIntroShown() {
  document.cookie = `${COOKIE_NAME}=1; max-age=31536000; path=/`
}

/**
 * Shows the brand intro on the first visit. The root layout reads the `pft_intro`
 * cookie server-side and passes `initialShow`, so the overlay is in the initial
 * HTML (no flash of the site) and repeat visits skip it with no flash at all.
 * The provider lives in the root layout, so it never replays on in-app navigation.
 */
export function PFTIntroProvider({
  children,
  initialShow = true,
}: {
  children: React.ReactNode
  initialShow?: boolean
}) {
  const [state, setState] = useState<IntroState>(initialShow ? 'playing' : 'done')
  const [reduced, setReduced] = useState(false)
  const timers = useRef<number[]>([])

  useEffect(() => {
    if (state !== 'playing') return

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // Static hold then dismiss, no rotation or exit motion.
      setReduced(true)
      markIntroShown()
      timers.current.push(window.setTimeout(() => setState('done'), 500))
      return
    }

    document.documentElement.style.overflow = 'hidden'
    timers.current.push(
      window.setTimeout(() => setState('exiting'), INTRO_MS),
      window.setTimeout(() => {
        document.documentElement.style.overflow = ''
        markIntroShown()
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
