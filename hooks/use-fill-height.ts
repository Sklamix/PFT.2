'use client'

import { useLayoutEffect, useRef, useState } from 'react'

type UseFillHeightOptions = {
  /** Extra padding below the element in px; defaults to reading the parent's computed padding-bottom. */
  paddingOffset?: number
  /** Minimum height in px. */
  minHeight?: number
}

export function useFillHeight<T extends HTMLElement>(options: UseFillHeightOptions = {}): {
  ref: React.RefObject<T | null>
  style: React.CSSProperties
} {
  const ref = useRef<T | null>(null)
  const [height, setHeight] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const parent = el.parentElement
    if (!parent) return
    const padding =
      options.paddingOffset ??
      (Number.parseFloat(window.getComputedStyle(parent).paddingBottom) || 24)

    const measure = () => {
      const rect = el.getBoundingClientRect()
      const next = Math.max(options.minHeight ?? 360, window.innerHeight - rect.top - padding)
      setHeight(next)
    }

    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(el)
    window.addEventListener('resize', measure)
    window.addEventListener('orientationchange', measure)
    const vv = window.visualViewport
    vv?.addEventListener('resize', measure)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('orientationchange', measure)
      vv?.removeEventListener('resize', measure)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { ref, style: height != null ? { height: `${height}px` } : {} }
}
