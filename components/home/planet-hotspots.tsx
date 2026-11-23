'use client'

import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { MoveHorizontal, RotateCw } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { PlanetController } from './planet-controller'
import { PLANET_SPOTS, type PlanetMode, type PlanetSpotId } from './planet-spots'

type DragSession = {
  pointerId: number
  startedAt: number
  startX: number
  startY: number
  lastX: number
  lastY: number
  lastAt: number
  pointerType: string
}

export function PlanetHotspots({
  mode,
  activeSpot,
  showFirstVisitHint,
  controller,
  isDesktop,
  onPlanetClick,
  onOpenSpot,
  onInteract,
}: {
  mode: PlanetMode
  activeSpot: PlanetSpotId | null
  showFirstVisitHint: boolean
  controller: PlanetController
  isDesktop: boolean
  onPlanetClick: () => void
  onOpenSpot: (spot: PlanetSpotId, trigger: HTMLButtonElement) => void
  onInteract: () => void
}) {
  const drag = useRef<DragSession | null>(null)

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const session = drag.current
    if (!session || session.pointerId !== event.pointerId) return

    const distance = Math.hypot(event.clientX - session.startX, event.clientY - session.startY)
    const duration = event.timeStamp - session.startedAt
    controller.finishDrag()
    drag.current = null
    event.currentTarget.dataset.dragging = 'false'

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (!cancelled && distance < 5 && duration < 400) onPlanetClick()
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (event.pointerType === 'mouse') event.preventDefault()
    event.stopPropagation()
    if (event.pointerType === 'mouse') event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.dataset.dragging = 'true'
    drag.current = {
      pointerId: event.pointerId,
      startedAt: event.timeStamp,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      lastAt: event.timeStamp,
      pointerType: event.pointerType,
    }
    controller.startDrag()
    onInteract()
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const session = drag.current
    if (!session || session.pointerId !== event.pointerId) return
    const totalX = event.clientX - session.startX
    const totalY = event.clientY - session.startY
    if (session.pointerType !== 'mouse' && !event.currentTarget.hasPointerCapture(event.pointerId)) {
      if (Math.hypot(totalX, totalY) < 6) return
      if (Math.abs(totalY) > Math.abs(totalX)) {
        controller.finishDrag()
        drag.current = null
        event.currentTarget.dataset.dragging = 'false'
        return
      }
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    if (session.pointerType === 'mouse') event.preventDefault()
    const dx = event.clientX - session.lastX
    const dy = event.clientY - session.lastY
    const elapsed = Math.max(event.timeStamp - session.lastAt, 8)
    controller.dragBy(dx, session.pointerType === 'mouse' ? dy : 0, elapsed)

    session.lastX = event.clientX
    session.lastY = event.clientY
    session.lastAt = event.timeStamp
  }

  return (
    <div
      inert={!isDesktop && mode === 'detail'}
      aria-hidden={!isDesktop && mode === 'detail'}
      className={cn(
        'pointer-events-none absolute inset-0 z-40 transition-opacity duration-500 motion-reduce:transition-none',
        !isDesktop && mode === 'detail' && 'opacity-0',
      )}
      aria-label="Planet advantages explorer"
    >
      <div
        ref={(node) => {
          controller.setBody(node)
        }}
        aria-hidden="true"
        data-dragging="false"
        className="pointer-events-auto absolute top-0 left-0 touch-pan-y rounded-full border border-primary/0 shadow-[0_0_80px_-34px_transparent] transition-[border-color,box-shadow] duration-500 hover:border-primary/15 hover:shadow-[0_0_90px_-28px_color-mix(in_oklab,var(--primary)_28%,transparent)] data-[dragging=true]:cursor-grabbing data-[dragging=false]:cursor-grab motion-reduce:transition-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => finishDrag(event)}
        onPointerCancel={(event) => finishDrag(event, true)}
        onPointerEnter={() => {
          controller.setHovered(true)
        }}
        onPointerLeave={() => {
          controller.setHovered(false)
        }}
      >
        {showFirstVisitHint && mode === 'hero' && isDesktop ? (
          <span
            className={cn(
              'pointer-events-none absolute left-1/2 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-white/10 bg-background/85 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-foreground/80 shadow-[0_12px_36px_-18px_rgb(0_0_0/0.9)] backdrop-blur-xl motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2',
              'top-0 -translate-y-10',
            )}
          >
            <MoveHorizontal className="size-3.5 text-primary" />
            Drag me
          </span>
        ) : null}
        {mode !== 'hero' && isDesktop ? (
          <span className="pointer-events-none absolute bottom-0 left-1/2 flex -translate-x-1/2 translate-y-[calc(100%+2.75rem)] items-center gap-2 whitespace-nowrap rounded-full border border-white/10 bg-background/80 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-foreground/75 backdrop-blur-xl">
            <RotateCw className="size-3.5 text-primary" />
            Drag to rotate · click a marker
          </span>
        ) : null}
      </div>

      {PLANET_SPOTS.map((spot) => (
        <button
          key={spot.id}
          ref={(node) => {
            controller.setMarker(spot.id, node)
          }}
          type="button"
          aria-label={spot.label}
          aria-pressed={activeSpot === spot.id}
          data-facing="false"
          className={cn(
            'group pointer-events-none absolute top-0 left-0 grid size-11 place-items-center rounded-full opacity-0 outline-none transition-[filter] duration-300 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-4 focus-visible:ring-offset-background lg:size-6',
            activeSpot === spot.id && 'drop-shadow-[0_0_12px_var(--primary)]',
          )}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            if (event.detail !== 0 && event.currentTarget.dataset.facing !== 'true') return
            event.stopPropagation()
            onInteract()
            onOpenSpot(spot.id, event.currentTarget)
          }}
        >
          <span className="absolute size-6 rounded-full bg-primary/20 blur-[5px] transition-transform duration-300 group-hover:scale-150 group-focus-visible:scale-150 lg:size-5" />
          <span className="absolute size-3.5 rounded-full border border-primary/40 motion-safe:animate-ping motion-safe:[animation-duration:2.4s] lg:size-3" />
          <span className="relative size-2.5 rounded-full border border-white/70 bg-highlight shadow-[0_0_12px_var(--highlight)] transition-transform duration-300 group-hover:scale-150 group-focus-visible:scale-150 lg:size-2" />
        </button>
      ))}
    </div>
  )
}
