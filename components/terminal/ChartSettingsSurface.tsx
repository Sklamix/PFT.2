'use client'

import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

type ChartSettingsSurfaceProps = {
  open: boolean
  onClose: () => void
  wrapperRef: React.RefObject<HTMLDivElement | null>
}

export function ChartSettingsSurface({ open, onClose, wrapperRef }: ChartSettingsSurfaceProps) {
  const titleRef = useRef<HTMLHeadingElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const wasOpenRef = useRef(false)

  // Focus the close button when the surface opens.
  useEffect(() => {
    if (!open || !closeRef.current) return
    closeRef.current.focus()
  }, [open])

  // Return focus to the chart wrapper when the surface closes.
  // Only return focus after the surface has actually been open, so loading
  // the terminal does not steal focus into the chart container on mount.
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true
      return
    }
    if (!wasOpenRef.current) return
    wasOpenRef.current = false
    const wrapper = wrapperRef.current
    if (wrapper) {
      ;(wrapper as HTMLElement).focus()
    }
  }, [open, wrapperRef])

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
    }
  }

  // A right-click inside the settings surface is not the plot: do nothing.
  function onSurfaceContextMenu(event: React.MouseEvent) {
    event.stopPropagation()
  }

  return (
    <>
      {open ? (
        <div
          ref={surfaceRef}
          data-chart-ui
          role="dialog"
          aria-labelledby="chart-settings-title"
          tabIndex={-1}
          className="absolute inset-0 z-40 bg-[#0b1122] outline-none"
          onContextMenu={onSurfaceContextMenu}
          onKeyDown={onKeyDown}
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <h2
              ref={titleRef}
              id="chart-settings-title"
              className="font-mono text-xs font-semibold text-foreground"
            >
              Chart settings
            </h2>
            <button
              ref={closeRef}
              type="button"
              aria-label="Close chart settings"
              onClick={onClose}
              className="h-7 w-7 rounded-md border border-border bg-secondary/60 px-2 font-mono text-[11px] text-foreground hover:bg-secondary/80"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
          <div className="p-3 text-xs text-muted-foreground">No settings yet.</div>
        </div>
      ) : null}
    </>
  )
}
