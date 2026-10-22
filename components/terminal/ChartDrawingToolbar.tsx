'use client'

import { useState } from 'react'
import {
  Check,
  GitBranch,
  LayoutTemplate,
  Minus,
  MousePointer2,
  Square,
  Trash2,
  TrendingUp,
  Undo2,
  X,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTradingStore } from '@/lib/stores/useTradingStore'
import { useTimeframeStore } from '@/lib/stores/useTimeframeStore'
import { useChartLayoutStore, type ChartDrawing, type ChartTool } from '@/lib/stores/useChartLayoutStore'
import { cn } from '@/lib/utils'

const EMPTY_DRAWINGS: ChartDrawing[] = []

const TOOLS: { id: ChartTool; label: string; icon: typeof MousePointer2 }[] = [
  { id: 'cursor', label: 'Cursor / pan', icon: MousePointer2 },
  { id: 'trend', label: 'Trend line', icon: TrendingUp },
  { id: 'horizontal', label: 'Horizontal line', icon: Minus },
  { id: 'rectangle', label: 'Rectangle', icon: Square },
  { id: 'fib', label: 'Fibonacci retracement', icon: GitBranch },
]

export function ChartDrawingToolbar() {
  const selectedSymbol = useTradingStore((state) => state.selectedSymbol)
  const timeframe = useTimeframeStore((state) => state.selected)
  const tool = useChartLayoutStore((state) => state.tool)
  const setTool = useChartLayoutStore((state) => state.setTool)
  const drawings = useChartLayoutStore((state) => state.drawingsBySymbol[selectedSymbol] ?? EMPTY_DRAWINGS)
  const templates = useChartLayoutStore((state) => state.templates)
  const removeLast = useChartLayoutStore((state) => state.removeLast)
  const clearDrawings = useChartLayoutStore((state) => state.clearDrawings)
  const saveTemplate = useChartLayoutStore((state) => state.saveTemplate)
  const applyTemplate = useChartLayoutStore((state) => state.applyTemplate)
  const deleteTemplate = useChartLayoutStore((state) => state.deleteTemplate)
  const [name, setName] = useState('')

  function save() {
    saveTemplate(name, selectedSymbol, timeframe)
    setName('')
  }

  return (
    <div className="absolute left-2 top-1/2 z-20 flex -translate-y-1/2 flex-col items-center gap-0.5 rounded-md border border-border bg-[#0b111d]/95 p-0.5 shadow-[0_6px_24px_rgba(0,0,0,0.45)] backdrop-blur-sm">
      {TOOLS.map((item) => {
        const Icon = item.icon
        return (
          <button
            key={item.id}
            type="button"
            title={item.label}
            aria-label={item.label}
            aria-pressed={tool === item.id}
            onClick={() => setTool(item.id)}
            className={cn(
              'flex size-6 items-center justify-center rounded transition-colors',
              tool === item.id
                ? 'bg-primary/20 text-primary'
                : 'text-muted-foreground hover:bg-secondary/70 hover:text-foreground',
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </button>
        )
      })}
      <span className="my-0.5 h-px w-4 bg-border" aria-hidden="true" />
      <button
        type="button"
        title="Undo last drawing"
        aria-label="Undo last drawing"
        disabled={drawings.length === 0}
        onClick={() => removeLast(selectedSymbol)}
        className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary/70 hover:text-foreground disabled:opacity-30"
      >
        <Undo2 className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        title="Clear drawings"
        aria-label="Clear drawings"
        disabled={drawings.length === 0}
        onClick={() => {
          if (window.confirm('Clear all drawings for this symbol?')) clearDrawings(selectedSymbol)
        }}
        className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-danger/15 hover:text-danger disabled:opacity-30"
      >
        <Trash2 className="size-3.5" aria-hidden="true" />
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              title="Chart templates"
              aria-label="Chart templates"
              className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary/70 hover:text-foreground"
            />
          }
        >
          <LayoutTemplate className="size-3.5" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right" className="w-72 p-0">
          <div className="border-b border-border p-2.5">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Save current layout</p>
            <div className="flex items-center gap-1.5">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') return
                  event.stopPropagation()
                  if (event.key === 'Enter') save()
                }}
                placeholder={`Template ${templates.length + 1}`}
                aria-label="Template name"
                className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background/70 px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring"
              />
              <button
                type="button"
                onClick={save}
                className="h-8 shrink-0 rounded-md border border-primary/40 bg-primary/15 px-2.5 font-mono text-[10px] text-primary transition-colors hover:bg-primary/25"
              >
                Save
              </button>
            </div>
            <p className="mt-1.5 font-mono text-[9px] text-muted-foreground">
              Saves drawings and the {timeframe} timeframe.
            </p>
          </div>

          <div className="max-h-64 overflow-y-auto p-1">
            <p className="px-2 py-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Templates
            </p>
            {templates.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">No templates saved yet.</p>
            ) : (
              templates.map((template) => (
                <div key={template.id} className="flex items-center gap-1 rounded-md px-1 py-1 hover:bg-secondary/50">
                  <button
                    type="button"
                    onClick={() => applyTemplate(template.id, selectedSymbol)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left"
                  >
                    <Check className="size-3 shrink-0 text-primary" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-foreground">{template.name}</span>
                      <span className="block font-mono text-[9px] text-muted-foreground">
                        {template.timeframe} · {template.drawings.length} object{template.drawings.length === 1 ? '' : 's'}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete template ${template.name}`}
                    onClick={() => deleteTemplate(template.id)}
                    className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-danger/15 hover:text-danger"
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                </div>
              ))
            )}
          </div>
          <DropdownMenuSeparator />
          <p className="px-3 py-2 font-mono text-[9px] leading-relaxed text-muted-foreground">
            Drawings and templates are saved in this browser.
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
