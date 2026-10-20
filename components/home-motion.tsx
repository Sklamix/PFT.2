'use client'

import { useEffect, useRef, type ReactNode } from 'react'

export function HomeMotion({ children }: { children: ReactNode }) {
  const scopeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const scope = scopeRef.current
    if (!scope) return

    const targets = scope.querySelectorAll<HTMLElement>('[data-home-reveal]')
    if (!targets.length) return

    if (!('IntersectionObserver' in window)) {
      targets.forEach((target) => target.classList.add('is-visible'))
      return
    }

    scope.classList.add('home-motion-ready')

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return
          entry.target.classList.add('is-visible')
          observer.unobserve(entry.target)
        })
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    )

    targets.forEach((target) => observer.observe(target))
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={scopeRef} className="home-motion-scope">
      {children}
    </div>
  )
}
