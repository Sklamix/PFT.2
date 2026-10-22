'use client'

import { create } from 'zustand'
import { parseTimeframe } from '@/lib/terminal/candles'
import { useTimeframeStore } from './useTimeframeStore'

export const CHART_LAYOUT_STORAGE_KEY = 'pft_chart_layout_v1'

export type DrawingTool = 'trend' | 'horizontal' | 'rectangle' | 'fib'
export type ChartTool = 'cursor' | DrawingTool

export type ChartPoint = {
  time: number
  price: number
}

export type ChartDrawing = {
  id: string
  type: DrawingTool
  points: ChartPoint[]
  color: string
  createdAt: number
}

export type ChartTemplate = {
  id: string
  name: string
  timeframe: string
  drawings: ChartDrawing[]
  createdAt: number
}

export const DRAWING_COLORS: Record<DrawingTool, string> = {
  trend: '#38bdf8',
  horizontal: '#eab308',
  rectangle: '#a855f7',
  fib: '#f472b6',
}

type StoredLayout = {
  drawingsBySymbol: Record<string, ChartDrawing[]>
  templates: ChartTemplate[]
}

type LayoutStore = {
  drawingsBySymbol: Record<string, ChartDrawing[]>
  templates: ChartTemplate[]
  tool: ChartTool
  setTool: (tool: ChartTool) => void
  addDrawing: (symbol: string, drawing: ChartDrawing) => void
  removeLast: (symbol: string) => void
  clearDrawings: (symbol: string) => void
  saveTemplate: (name: string, symbol: string, timeframe: string) => void
  applyTemplate: (templateId: string, symbol: string) => void
  deleteTemplate: (templateId: string) => void
}

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function persist(drawingsBySymbol: Record<string, ChartDrawing[]>, templates: ChartTemplate[]) {
  try {
    window.localStorage.setItem(CHART_LAYOUT_STORAGE_KEY, JSON.stringify({ drawingsBySymbol, templates }))
  } catch {
    // Storage can be unavailable (private mode); the drawings still work for this session.
  }
}

function validPoint(value: unknown): value is ChartPoint {
  if (!value || typeof value !== 'object') return false
  const point = value as { time?: unknown; price?: unknown }
  return typeof point.time === 'number' && Number.isFinite(point.time) && typeof point.price === 'number' && Number.isFinite(point.price)
}

function validDrawings(value: unknown): ChartDrawing[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const drawing = item as Partial<ChartDrawing>
    if (
      typeof drawing.id !== 'string' ||
      (drawing.type !== 'trend' && drawing.type !== 'horizontal' && drawing.type !== 'rectangle' && drawing.type !== 'fib') ||
      !Array.isArray(drawing.points) ||
      !drawing.points.every(validPoint) ||
      typeof drawing.color !== 'string'
    ) {
      return []
    }
    return [{
      id: drawing.id,
      type: drawing.type,
      points: drawing.points,
      color: drawing.color,
      createdAt: typeof drawing.createdAt === 'number' ? drawing.createdAt : Date.now(),
    }]
  })
}

export const useChartLayoutStore = create<LayoutStore>((set, get) => ({
  drawingsBySymbol: {},
  templates: [],
  tool: 'cursor',

  setTool: (tool) => set({ tool }),

  addDrawing: (symbol, drawing) => {
    const { drawingsBySymbol, templates } = get()
    const next = { ...drawingsBySymbol, [symbol]: [...(drawingsBySymbol[symbol] ?? []), drawing] }
    persist(next, templates)
    set({ drawingsBySymbol: next })
  },

  removeLast: (symbol) => {
    const { drawingsBySymbol, templates } = get()
    const next = { ...drawingsBySymbol, [symbol]: (drawingsBySymbol[symbol] ?? []).slice(0, -1) }
    persist(next, templates)
    set({ drawingsBySymbol: next })
  },

  clearDrawings: (symbol) => {
    const { drawingsBySymbol, templates } = get()
    const next = { ...drawingsBySymbol, [symbol]: [] }
    persist(next, templates)
    set({ drawingsBySymbol: next })
  },

  saveTemplate: (name, symbol, timeframe) => {
    const { drawingsBySymbol, templates } = get()
    const cleanName = name.trim() || `Template ${templates.length + 1}`
    const template: ChartTemplate = {
      id: makeId(),
      name: cleanName.slice(0, 48),
      timeframe,
      drawings: (drawingsBySymbol[symbol] ?? []).map((drawing) => ({
        ...drawing,
        points: drawing.points.map((point) => ({ ...point })),
      })),
      createdAt: Date.now(),
    }
    const next = [...templates, template]
    persist(drawingsBySymbol, next)
    set({ templates: next })
  },

  applyTemplate: (templateId, symbol) => {
    const { drawingsBySymbol, templates } = get()
    const template = templates.find((item) => item.id === templateId)
    if (!template) return
    const copies = template.drawings.map((drawing) => ({
      ...drawing,
      id: makeId(),
      points: drawing.points.map((point) => ({ ...point })),
      createdAt: Date.now(),
    }))
    const next = { ...drawingsBySymbol, [symbol]: copies }
    persist(next, templates)
    set({ drawingsBySymbol: next, tool: 'cursor' })
    const timeframe = parseTimeframe(template.timeframe)
    if (timeframe) useTimeframeStore.getState().select(timeframe)
  },

  deleteTemplate: (templateId) => {
    const { drawingsBySymbol, templates } = get()
    const next = templates.filter((item) => item.id !== templateId)
    persist(drawingsBySymbol, next)
    set({ templates: next })
  },
}))

export function loadStoredChartLayout() {
  try {
    const raw = window.localStorage.getItem(CHART_LAYOUT_STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Partial<StoredLayout> | null
    if (!parsed || typeof parsed !== 'object') return

    const drawingsBySymbol: Record<string, ChartDrawing[]> = {}
    if (parsed.drawingsBySymbol && typeof parsed.drawingsBySymbol === 'object') {
      for (const [symbol, value] of Object.entries(parsed.drawingsBySymbol)) {
        const drawings = validDrawings(value)
        if (drawings.length) drawingsBySymbol[symbol] = drawings
      }
    }

    const templates = Array.isArray(parsed.templates)
      ? parsed.templates.flatMap((item): ChartTemplate[] => {
          if (!item || typeof item !== 'object') return []
          const template = item as Partial<ChartTemplate>
          if (typeof template.id !== 'string' || typeof template.name !== 'string') return []
          return [{
            id: template.id,
            name: template.name,
            timeframe: typeof template.timeframe === 'string' ? template.timeframe : '5m',
            drawings: validDrawings(template.drawings),
            createdAt: typeof template.createdAt === 'number' ? template.createdAt : Date.now(),
          }]
        })
      : []

    useChartLayoutStore.setState({ drawingsBySymbol, templates })
  } catch {
    // Ignore malformed or unavailable storage.
  }
}
