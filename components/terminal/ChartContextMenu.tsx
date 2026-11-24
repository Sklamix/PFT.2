'use client'

import { useEffect, useRef, useState } from 'react'
import { formatPrice } from '@/lib/constants/symbols'
import { useChartLayoutStore } from '@/lib/stores/useChartLayoutStore'
import { cn } from '@/lib/utils'

const MENU_GUTTER = 8
const COPY_CONFIRM_MS = 1_200

type MenuItemKind = 'item' | 'separator' | 'group'

type MenuItem = {
  kind: MenuItemKind
  id: string
  label: string
  enabled: boolean
  action: () => void
  ariaDisabled?: boolean
}

function drawingLabel(drawing: { type: string; points: Array<{ price: number }> }, symbol: string) {
  const base =
    drawing.type === 'trend'
      ? 'Trend line'
      : drawing.type === 'horizontal'
        ? 'Horizontal'
        : drawing.type === 'rectangle'
          ? 'Rectangle'
          : 'Fibonacci'
  if (drawing.type === 'horizontal') {
    const price = drawing.points[0]?.price
    return price != null ? `${base} ${formatPrice(symbol, price)}` : base
  }
  return base
}

type ChartContextMenuProps = {
  open: boolean
  x: number
  y: number
  symbol: string
  price: number
  wrapperRef: React.RefObject<HTMLDivElement | null>
  onClose: () => void
  onCopyError: () => void
  onNotifyMe: (symbol: string, price: number) => void
  onFitChart: () => void
  onDeleteDrawing: (symbol: string, id: string) => void
  onClearDrawings: (symbol: string) => void
  onOpenSettings: () => void
}

export function ChartContextMenu({
  open,
  x,
  y,
  symbol,
  price,
  wrapperRef,
  onClose,
  onCopyError,
  onNotifyMe,
  onFitChart,
  onDeleteDrawing,
  onClearDrawings,
  onOpenSettings,
}: ChartContextMenuProps) {
  const [expandedDelete, setExpandedDelete] = useState(false)
  const [copyConfirmed, setCopyConfirmed] = useState(false)
  const [focusIndex, setFocusIndex] = useState(-1)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const menuRef = useRef<HTMLDivElement>(null)
  const itemElements = useRef<HTMLElement[]>([])
  const copyTimerRef = useRef<number | null>(null)

  const drawings = useChartLayoutStore((state) => state.drawingsBySymbol[symbol] ?? [])

  const hasDrawings = drawings.length > 0
  const isPriceResolved = price != null && Number.isFinite(price) && price > 0

  // Build the menu item list. When expandedDelete, drawing rows replace the
  // "Delete a drawing" parent item in the list.
  const items: MenuItem[] = [
    {
      kind: 'item',
      id: 'copy-level',
      label: 'Copy level',
      enabled: isPriceResolved,
      action: async () => {
        const success = await handleCopyLevel()
        if (!success) onCopyError()
      },
      ariaDisabled: !isPriceResolved,
    },
    {
      kind: 'item',
      id: 'notify-me',
      label: 'Notify me at this level',
      enabled: isPriceResolved,
      action: () => {
        onNotifyMe(symbol, price)
        onClose()
      },
      ariaDisabled: !isPriceResolved,
    },
    { kind: 'separator', id: 'sep-1', label: '', enabled: false, action: () => {} },
    {
      kind: 'item',
      id: 'fit-chart',
      label: 'Fit chart to data',
      enabled: true,
      action: () => {
        onFitChart()
        onClose()
      },
    },
    { kind: 'separator', id: 'sep-2', label: '', enabled: false, action: () => {} },
  ]

  if (expandedDelete) {
    for (const drawing of drawings) {
      items.push({
        kind: 'item',
        id: `drawing-${drawing.id}`,
        label: drawingLabel(drawing, symbol),
        enabled: true,
        action: () => {
          onDeleteDrawing(symbol, drawing.id)
          onClose()
        },
      })
    }
    if (drawings.length === 0) {
      items.push({
        kind: 'group',
        id: 'drawing-empty',
        label: 'No drawings.',
        enabled: false,
        action: () => {},
      })
    }
  } else {
    items.push({
      kind: 'item',
      id: 'delete-drawing',
      label: 'Delete a drawing',
      enabled: hasDrawings,
      action: () => setExpandedDelete(true),
      ariaDisabled: !hasDrawings,
    })
  }

  items.push(
    {
      kind: 'item',
      id: 'clear-drawings',
      label: 'Clear all drawings',
      enabled: hasDrawings,
      action: () => {
        onClearDrawings(symbol)
        onClose()
      },
      ariaDisabled: !hasDrawings,
    },
    { kind: 'separator', id: 'sep-3', label: '', enabled: false, action: () => {} },
    {
      kind: 'item',
      id: 'chart-settings',
      label: 'Chart settings',
      enabled: true,
      action: () => {
        onOpenSettings()
        onClose()
      },
    },
  )

  const focusableIndices = items
    .map((item, index) => (item.kind === 'item' && item.enabled ? index : null))
    .filter((index): index is number => index !== null)

  // Reset expanded state when the menu closes.
  useEffect(() => {
    if (!open) setExpandedDelete(false)
  }, [open])

  // Measure and clamp position after mount/open, then re-render with clamped pos.
  useEffect(() => {
    if (!open) {
      setPos({ x, y })
      return
    }
    const menu = menuRef.current
    const wrapper = wrapperRef.current
    if (!menu || !wrapper) return

    const wrapperRect = wrapper.getBoundingClientRect()
    const baseX = Math.max(MENU_GUTTER, Math.min(x, wrapperRect.width - MENU_GUTTER))
    const baseY = Math.max(MENU_GUTTER, Math.min(y, wrapperRect.height - MENU_GUTTER))
    setPos({ x: baseX, y: baseY })

    const measure = () => {
      const menuRect = menu.getBoundingClientRect()
      let nextX = baseX
      let nextY = baseY

      if (nextX + menuRect.width > wrapperRect.width - MENU_GUTTER) {
        nextX = wrapperRect.width - menuRect.width - MENU_GUTTER
      }
      if (nextX < MENU_GUTTER) nextX = MENU_GUTTER
      if (nextY + menuRect.height > wrapperRect.height - MENU_GUTTER) {
        nextY = wrapperRect.height - menuRect.height - MENU_GUTTER
      }
      if (nextY < MENU_GUTTER) nextY = MENU_GUTTER

      setPos({ x: nextX, y: nextY })
    }

    requestAnimationFrame(measure)
  }, [open, x, y, wrapperRef, expandedDelete, drawings.length])

  // Focus first enabled item on open.
  useEffect(() => {
    if (!open) {
      setFocusIndex(-1)
      return
    }
    setFocusIndex(focusableIndices.length > 0 ? focusableIndices[0] : -1)
  }, [open, focusableIndices])

  // Focus the DOM element matching focusIndex.
  useEffect(() => {
    itemElements.current.forEach((el) => el.setAttribute('tabIndex', '-1'))
    const active = focusIndex >= 0 ? itemElements.current[focusIndex] : null
    if (active) active.focus()
  }, [focusIndex])

  // Keyboard navigation.
  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (focusableIndices.length === 0) return
      const currentPos = focusableIndices.indexOf(focusIndex)
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        const nextPos = (currentPos + 1) % focusableIndices.length
        setFocusIndex(focusableIndices[nextPos])
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        const nextPos = (currentPos - 1 + focusableIndices.length) % focusableIndices.length
        setFocusIndex(focusableIndices[nextPos])
      } else if (event.key === 'Home') {
        event.preventDefault()
        setFocusIndex(focusableIndices[0])
      } else if (event.key === 'End') {
        event.preventDefault()
        setFocusIndex(focusableIndices[focusableIndices.length - 1])
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        const item = items[focusIndex]
        if (item && item.enabled) item.action()
      }
    }
    function onScroll() {
      onClose()
    }
    function onResize() {
      onClose()
    }
    function onBlur(event: FocusEvent) {
      const menu = menuRef.current
      if (menu && !menu.contains(event.relatedTarget as Node | null)) {
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, { capture: true })
    window.addEventListener('resize', onResize)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('resize', onResize)
      window.removeEventListener('blur', onBlur)
    }
  }, [open, onClose, items, focusIndex, focusableIndices])

  // Cleanup copy timer on unmount.
  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    }
  }, [])

  // Collapse drawing list when empty.
  useEffect(() => {
    if (expandedDelete && drawings.length === 0) setExpandedDelete(false)
  }, [expandedDelete, drawings.length])

  async function handleCopyLevel() {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    setCopyConfirmed(false)
    const text = formatPrice(symbol, price)
    try {
      await navigator.clipboard.writeText(text)
      setCopyConfirmed(true)
      copyTimerRef.current = window.setTimeout(() => {
        setCopyConfirmed(false)
        onClose()
      }, COPY_CONFIRM_MS)
      return true
    } catch {
      try {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.setAttribute('readonly', '')
        textarea.style.position = 'absolute'
        textarea.style.left = '-9999px'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
        setCopyConfirmed(true)
        copyTimerRef.current = window.setTimeout(() => {
          setCopyConfirmed(false)
          onClose()
        }, COPY_CONFIRM_MS)
        return true
      } catch {
        return false
      }
    }
  }

  function handlePointerDown(event: React.PointerEvent) {
    const menu = menuRef.current
    if (menu && !menu.contains(event.target as Node)) {
      onClose()
    }
  }

  useEffect(() => {
    if (open) {
      window.addEventListener('pointerdown', handlePointerDown as unknown as EventListener, true)
    }
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown as unknown as EventListener, true)
    }
  }, [open, handlePointerDown])

  return (
    <>
      {open ? (
        <div
          ref={menuRef}
          data-chart-ui
          role="menu"
          tabIndex={-1}
          className={cn(
            'absolute z-50 flex flex-col min-w-[180px] border border-border rounded-lg overflow-hidden bg-[#0b1122] text-xs shadow-[0_10px_40px_rgba(0,0,0,0.5)] ring-1 ring-white/10',
            'select-none',
          )}
          style={{ left: pos.x, top: pos.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {items.map((item, index) => {
            if (item.kind === 'separator') {
              return (
                <div key={item.id} className="border-t border-border my-1" aria-hidden="true" />
              )
            }
            if (item.kind === 'group') {
              return (
                <div
                  key={item.id}
                  className="px-3 py-2 text-[11px] font-mono text-muted-foreground"
                >
                  {item.label}
                </div>
              )
            }
            const itemIndex = index
            const isDrawingItem = item.id.startsWith('drawing-')
            const isCopyConfirmed = item.id === 'copy-level' && copyConfirmed
            const drawing = isDrawingItem ? drawings.find((d) => `drawing-${d.id}` === item.id) : null
            return (
              <div
                key={item.id}
                ref={(el) => {
                  if (el) itemElements.current[itemIndex] = el
                }}
                role="menuitem"
                id={`menu-${item.id}`}
                aria-disabled={item.ariaDisabled ? 'true' : undefined}
                data-disabled={item.ariaDisabled ? 'true' : undefined}
                tabIndex={focusIndex === itemIndex ? 0 : -1}
                onClick={(event) => {
                  if (event.target instanceof HTMLButtonElement) return
                  if (!item.enabled) return
                  item.action()
                }}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 text-[11px] font-mono outline-none cursor-default',
                  !item.enabled ? 'text-muted-foreground/50' : 'text-foreground hover:bg-primary/10',
                )}
              >
                {isDrawingItem && drawing ? (
                  <span
                    className="size-3 shrink-0 rounded border border-border"
                    style={{ backgroundColor: drawing.color }}
                    aria-hidden="true"
                  />
                ) : null}
                {isCopyConfirmed ? (
                  <span role="status" className="ml-auto text-[10px] text-primary">
                    Copied
                  </span>
                ) : null}
                {item.label}
                {!isDrawingItem && item.id === 'delete-drawing' ? (
                  <span className="text-[10px] ml-auto">▸</span>
                ) : null}
                {isDrawingItem && drawing ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      item.action()
                    }}
                    className="shrink-0 p-1 text-muted-foreground hover:text-danger"
                    aria-label={`Delete ${item.label}`}
                  >
                    ⌫
                  </button>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </>
  )
}
