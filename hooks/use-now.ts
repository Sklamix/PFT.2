'use client'

import { useSyncExternalStore } from 'react'

let now: number | null = null
let timer: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!timer) {
    timer = setInterval(() => {
      now = Date.now()
      listeners.forEach((notify) => notify())
    }, 1000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

function getSnapshot() {
  if (now === null) now = Date.now()
  return now
}

function getServerSnapshot() {
  return null
}

/** Shared 1s ticking clock. Returns null during SSR/hydration to avoid mismatches. */
export function useNow() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
