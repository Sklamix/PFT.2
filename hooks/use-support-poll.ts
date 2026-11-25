'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

type UseSupportPollOptions = {
  /** Returns a URL to poll, or null to pause. Evaluated every tick (see note in docs). */
  getUrl: () => string | null
  enabled?: boolean
  intervalMs?: number
  hiddenIntervalMs?: number
  onData?: (data: unknown) => void
  onError?: (error: Error) => void
}

/**
 * HTTP-polling hook for support ticket lists.
 *
 * Chain-based (setTimeout, not setInterval) with backoff: slow responses push
 * the next tick out rather than piling up concurrent requests. Uses an
 * AbortController per tick and ignores AbortError.
 */
export function useSupportPoll(options: UseSupportPollOptions) {
  const { getUrl, enabled = true, intervalMs = 3000, hiddenIntervalMs = 15_000, onData, onError } = options
  const [polling, setPolling] = useState(enabled)
  const activeRef = useRef(false)
  const timeoutRef = useRef<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const delayRef = useRef(intervalMs)
  const onDataRef = useRef(onData)
  const onErrorRef = useRef(onError)
  const getUrlRef = useRef(getUrl)

  useEffect(() => {
    onDataRef.current = onData
    onErrorRef.current = onError
    getUrlRef.current = getUrl
  }, [onData, onError, getUrl])

  const doPoll = useCallback(async () => {
    if (activeRef.current) return
    activeRef.current = true
    abortRef.current?.abort()

    const controller = new AbortController()
    abortRef.current = controller

    const url = getUrlRef.current()
    if (!url || !enabled) {
      activeRef.current = false
      setPolling(false)
      return
    }

    setPolling(true)
    try {
      const response = await fetch(url, { cache: 'no-store', signal: controller.signal })
      if (controller.signal.aborted) return
      const data = await response.json()
      if (controller.signal.aborted) return
      if (response.ok) {
        delayRef.current = intervalMs
        onDataRef.current?.(data)
      } else {
        delayRef.current = Math.min(delayRef.current * 2, 30_000)
        onErrorRef.current?.(new Error(`HTTP ${response.status}`))
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return
      delayRef.current = Math.min(delayRef.current * 2, 30_000)
      onErrorRef.current?.(error instanceof Error ? error : new Error(String(error)))
    } finally {
      activeRef.current = false
      if (controller === abortRef.current) {
        timeoutRef.current = window.setTimeout(() => void doPoll(), delayRef.current)
      }
    }
  }, [enabled, intervalMs])

  // Visibility change: pause when hidden (if hiddenIntervalMs is 0, we set timeout to 0 → effectively pause),
  // and immediately poll when returning to the page.
  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === 'hidden') {
        if (timeoutRef.current) clearTimeout(timeoutRef.current)
        timeoutRef.current = hiddenIntervalMs
          ? window.setTimeout(() => void doPoll(), hiddenIntervalMs)
          : null // pause
      } else if (document.visibilityState === 'visible') {
        void doPoll()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [doPoll, hiddenIntervalMs])

  useEffect(() => {
    timeoutRef.current = window.setTimeout(() => void doPoll(), 0)
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      abortRef.current?.abort()
    }
  }, [doPoll])

  return { polling }
}
