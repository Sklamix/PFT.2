'use client'

import { useEffect, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'

type MotionState = {
  elapsed: number
  pulse: number
  pulseX: number
  pulseY: number
  x: number
  y: number
  vx: number
  vy: number
}

const INITIAL_MOTION_STATE: MotionState = {
  elapsed: 0,
  pulse: 1,
  pulseX: 0,
  pulseY: 0,
  x: 0,
  y: 0,
  vx: 34,
  vy: 22,
}

export function KineticOrbit() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const motionRef = useRef<MotionState>(INITIAL_MOTION_STATE)
  const [animationEnabled, setAnimationEnabled] = useState(false)

  useEffect(() => {
    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const updateFromPreference = () => setAnimationEnabled(!motionPreference.matches)
    updateFromPreference()
    motionPreference.addEventListener('change', updateFromPreference)
    return () => motionPreference.removeEventListener('change', updateFromPreference)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return

    let width = 0
    let height = 0
    let frame = 0
    let previousTime = 0
    let { elapsed, pulse, pulseX, pulseY, x, y, vx, vy } = motionRef.current

    const resize = () => {
      const bounds = canvas.getBoundingClientRect()
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
      width = bounds.width
      height = bounds.height
      canvas.width = Math.round(width * pixelRatio)
      canvas.height = Math.round(height * pixelRatio)
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
      draw()
    }

    const draw = () => {
      const centerX = width / 2
      const centerY = height / 2
      const outerRadius = Math.min(width, height) * 0.215
      const innerRadius = outerRadius * 0.34
      const maxDistance = outerRadius - innerRadius

      context.clearRect(0, 0, width, height)

      const zoneGlow = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, outerRadius * 1.2)
      zoneGlow.addColorStop(0, 'rgba(163, 230, 53, 0.055)')
      zoneGlow.addColorStop(0.58, 'rgba(163, 230, 53, 0.035)')
      zoneGlow.addColorStop(1, 'rgba(163, 230, 53, 0)')
      context.fillStyle = zoneGlow
      context.fillRect(centerX - outerRadius * 1.2, centerY - outerRadius * 1.2, outerRadius * 2.4, outerRadius * 2.4)

      if (pulse < 1) {
        const progress = 1 - pulse
        const flashRadius = 8 + progress * 30
        const flash = context.createRadialGradient(pulseX, pulseY, 0, pulseX, pulseY, flashRadius)
        flash.addColorStop(0, `rgba(190, 242, 100, ${(1 - progress) * 0.32})`)
        flash.addColorStop(1, 'rgba(163, 230, 53, 0)')
        context.fillStyle = flash
        context.beginPath()
        context.arc(pulseX, pulseY, flashRadius, 0, Math.PI * 2)
        context.fill()
      }

      const distance = Math.hypot(x, y)
      if (distance > maxDistance) {
        x = (x / distance) * maxDistance
        y = (y / distance) * maxDistance
      }

      const dotX = centerX + x
      const dotY = centerY + y
      const dotGlow = context.createRadialGradient(dotX, dotY, 0, dotX, dotY, innerRadius * 2.2)
      dotGlow.addColorStop(0, 'rgba(163, 230, 53, 0.24)')
      dotGlow.addColorStop(0.42, 'rgba(163, 230, 53, 0.1)')
      dotGlow.addColorStop(1, 'rgba(163, 230, 53, 0)')
      context.fillStyle = dotGlow
      context.beginPath()
      context.arc(dotX, dotY, innerRadius * 2.2, 0, Math.PI * 2)
      context.fill()

      const ballFill = context.createRadialGradient(
        dotX - innerRadius * 0.25,
        dotY - innerRadius * 0.25,
        innerRadius * 0.05,
        dotX,
        dotY,
        innerRadius,
      )
      ballFill.addColorStop(0, 'rgba(190, 242, 100, 0.34)')
      ballFill.addColorStop(0.55, 'rgba(163, 230, 53, 0.18)')
      ballFill.addColorStop(1, 'rgba(163, 230, 53, 0.025)')
      context.beginPath()
      context.arc(dotX, dotY, innerRadius, 0, Math.PI * 2)
      context.fillStyle = ballFill
      context.fill()
    }

    const animate = (time: number) => {
      if (!previousTime) previousTime = time
      const delta = Math.min((time - previousTime) / 1000, 0.04)
      previousTime = time
      elapsed += delta

      const centerX = width / 2
      const centerY = height / 2
      const outerRadius = Math.min(width, height) * 0.215
      const innerRadius = outerRadius * 0.34
      const maxDistance = outerRadius - innerRadius

      vx += (Math.sin(elapsed * 0.57) * 12 + Math.sin(elapsed * 0.19 + 1.7) * 8) * delta
      vy += (Math.cos(elapsed * 0.43 + 0.8) * 12 + Math.sin(elapsed * 0.23) * 8) * delta

      const speed = Math.hypot(vx, vy)
      const maxSpeed = 54
      if (speed > maxSpeed) {
        vx = (vx / speed) * maxSpeed
        vy = (vy / speed) * maxSpeed
      }

      x += vx * delta
      y += vy * delta

      const distance = Math.hypot(x, y)
      if (distance >= maxDistance) {
        const normalX = x / distance
        const normalY = y / distance
        const outwardSpeed = vx * normalX + vy * normalY

        x = normalX * maxDistance
        y = normalY * maxDistance
        if (outwardSpeed > 0) {
          vx -= 2 * outwardSpeed * normalX
          vy -= 2 * outwardSpeed * normalY
        }

        pulseX = centerX + x
        pulseY = centerY + y
        pulse = 0
      }

      pulse = Math.min(1, pulse + delta * 1.7)
      draw()
      frame = window.requestAnimationFrame(animate)
    }

    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()

    if (animationEnabled) frame = window.requestAnimationFrame(animate)

    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(frame)
      motionRef.current = { elapsed, pulse, pulseX, pulseY, x, y, vx, vy }
    }
  }, [animationEnabled])

  return (
    <>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-1/2 size-[200%] -translate-1/2"
      />
      <button
        type="button"
        aria-label={animationEnabled ? 'Pause background animation' : 'Play background animation'}
        aria-pressed={animationEnabled}
        title={animationEnabled ? 'Pause background animation' : 'Play background animation'}
        onClick={() => setAnimationEnabled((enabled) => !enabled)}
        className="fixed right-3 bottom-3 z-20 grid size-8 place-items-center rounded-full border border-white/10 bg-[#080b0f]/40 text-slate-500 opacity-55 transition hover:border-lime-300/30 hover:text-lime-200 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300/60"
      >
        {animationEnabled ? <Pause aria-hidden="true" className="size-3" /> : <Play aria-hidden="true" className="size-3" />}
      </button>
    </>
  )
}
