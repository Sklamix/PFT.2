'use client'

import { useEffect, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { cn } from '@/lib/utils'
import { VenusScene } from './venus-scene'

/**
 * Full-screen brand intro: PFT wordmark, a rotating procedural Venus and a thin
 * progress line. The planet accelerates out of frame on exit while the overlay
 * fades, revealing the already-rendered page underneath.
 */
export function PFTLoadingScreen({ exiting, reduced }: { exiting: boolean; reduced: boolean }) {
  const barRef = useRef<HTMLDivElement>(null)
  const pctRef = useRef<HTMLSpanElement>(null)
  const started = useRef(false)

  // Controlled completion animation synced to the intro duration (no fake network).
  useEffect(() => {
    if (started.current) return
    started.current = true
    const duration = reduced ? 800 : 1950
    const start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 2.6)
      const pct = Math.round(eased * 100)
      if (barRef.current) barRef.current.style.width = `${eased * 100}%`
      if (pctRef.current) pctRef.current.textContent = `${pct}%`
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [reduced])

  return (
    <div
      aria-hidden="true"
      className={cn(
        'fixed inset-0 z-[9999] overflow-hidden bg-[#04040a] transition-opacity duration-700 ease-out',
        exiting && 'opacity-0',
      )}
    >
      {/* Faint stars */}
      <div className="cosmic-stars absolute inset-0" />

      {/* Ambient warm glow behind the planet */}
      <div
        className="absolute left-1/2 top-1/2 h-[52vh] w-[52vh] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-40 blur-3xl"
        style={{ background: 'radial-gradient(circle, rgba(255,154,60,0.28), transparent 65%)' }}
      />

      {/* PFT wordmark */}
      <div
        className={cn(
          'absolute inset-x-0 top-[13%] z-10 flex flex-col items-center transition-all duration-700 ease-out',
          exiting && '-translate-y-4 opacity-0 blur-sm',
        )}
      >
        <h1
          className="flex select-none gap-[0.14em] text-[clamp(3.5rem,12vw,7rem)] font-semibold leading-none tracking-[0.34em] text-white"
          style={{ textShadow: '0 0 40px rgba(59,130,246,0.35)' }}
        >
          {'PFT'.split('').map((letter, index) => (
            <span
              key={index}
              className={cn('inline-block', !reduced && 'animate-[pft-letter-in_0.55s_cubic-bezier(0.22,1,0.36,1)_both]')}
              style={reduced ? undefined : { animationDelay: `${0.08 + index * 0.1}s` }}
            >
              {letter}
            </span>
          ))}
        </h1>
        <p
          className={cn(
            'mt-4 text-[clamp(0.55rem,1.6vw,0.72rem)] uppercase tracking-[0.5em] text-slate-500',
            !reduced && 'animate-[pft-fade-in_0.9s_ease_0.5s_both]',
          )}
        >
          Professional Funded Trader
        </p>
      </div>

      {/* Venus (3D) — accelerates out of frame on exit */}
      <div
        className={cn(
          'absolute inset-x-0 bottom-[18%] top-[26%] transition-all duration-700 ease-out',
          exiting && 'translate-x-[22%] blur-md opacity-90',
        )}
      >
        <Canvas
          dpr={[1, 1.6]}
          gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
          camera={{ position: [0, 0, 4.4], fov: 44 }}
          style={{ pointerEvents: 'none' }}
        >
          <VenusScene exiting={exiting} />
        </Canvas>
      </div>

      {/* Progress line + percentage */}
      <div
        className={cn(
          'absolute inset-x-0 bottom-[9%] z-10 flex flex-col items-center gap-3 transition-all duration-700 ease-out',
          exiting && 'opacity-0 blur-sm',
        )}
      >
        <div className="h-px w-[min(320px,58vw)] overflow-hidden rounded-full bg-white/10">
          <div ref={barRef} className="h-full w-0 bg-gradient-to-r from-amber-200/80 via-amber-100 to-white" />
        </div>
        <span ref={pctRef} className="font-mono text-xs tabular-nums text-slate-400">
          0%
        </span>
      </div>
    </div>
  )
}
